package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

type fakeChannel struct {
	messages chan webrtc.DataChannelMessage
	closed   chan struct{}
	once     sync.Once
	buffered atomic.Uint64
}

func newFakeChannel() *fakeChannel {
	return &fakeChannel{messages: make(chan webrtc.DataChannelMessage, 256), closed: make(chan struct{})}
}
func (d *fakeChannel) Send(data []byte) error {
	select {
	case d.messages <- webrtc.DataChannelMessage{Data: append([]byte(nil), data...)}:
		return nil
	case <-d.closed:
		return io.ErrClosedPipe
	}
}
func (d *fakeChannel) SendText(data string) error {
	select {
	case d.messages <- webrtc.DataChannelMessage{IsString: true, Data: []byte(data)}:
		return nil
	case <-d.closed:
		return io.ErrClosedPipe
	}
}
func (d *fakeChannel) BufferedAmount() uint64 { return d.buffered.Load() }
func (d *fakeChannel) Close() error           { d.once.Do(func() { close(d.closed) }); return nil }
func incomingFrame(b *bridge, f wireFrame) {
	data, _ := json.Marshal(f)
	b.onMessage(webrtc.DataChannelMessage{IsString: true, Data: data})
}

func TestAllowedRequest(t *testing.T) {
	id := "00000000-0000-4000-8000-000000000000"
	for _, tc := range []struct {
		method, path string
		size         int64
		want         bool
	}{
		{"GET", "/api/session", 0, true}, {"GET", "/api/events", 0, true}, {"GET", "/api/items", 0, true},
		{"POST", "/api/items/text", 20, true}, {"POST", "/api/items/file", 500, true}, {"GET", "/api/items/" + id + "/file", 0, true},
		{"GET", "/api/items/" + id + "/preview?size=small", 0, true}, {"HEAD", "/api/items/" + id + "/file", 0, true},
		{"DELETE", "/api/items/" + id, 0, true}, {"PATCH", "/api/library/" + id, 50, true}, {"GET", "/api/library/" + id + "/content", 0, true},
		{"POST", "/api/auth/login", 0, false}, {"GET", "/api/p2p/config", 0, false}, {"GET", "/", 0, false},
		{"GET", "http://evil.example/api/items", 0, false}, {"GET", "//evil.example/api/items", 0, false},
		{"GET", "/api/items/../session", 0, false}, {"GET", "/api/items/%2e%2e/session", 0, false},
		{"GET", "/api/items%2f", 0, false}, {"GET", "/api/items#foo", 0, false}, {"GET", "/api/items\\foo", 0, false},
		{"POST", "/api/items", 0, false}, {"GET", "/api/items", 1, false}, {"POST", "/api/items/file", -1, false},
		{"POST", "/api/items/file", maxRequestBody + 1, false}, {"DELETE", "/api/library/" + id + "/content", 0, false},
	} {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			if got := allowedRequest(tc.method, tc.path, tc.size); got != tc.want {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}

func fixtureBridge(t *testing.T, handler http.HandlerFunc) (*bridge, *fakeChannel) {
	t.Helper()
	backend := httptest.NewServer(handler)
	t.Cleanup(backend.Close)
	u, _ := url.Parse(backend.URL)
	g := newGateway(config{backend: u}, nil)
	t.Cleanup(g.close)
	d := newFakeChannel()
	b := newBridge(context.Background(), d, g.client, u, identity{cookie: "clip_session=original", host: "clip.example.com"}, nil)
	t.Cleanup(b.close)
	return b, d
}

func TestLargeUploadDownloadStreamsWithCreditAndPreservesIdentity(t *testing.T) {
	body := bytes.Repeat([]byte("0123456789abcdef"), 200000)
	response := bytes.Repeat([]byte("response012345678"), 190000)
	received := make(chan []byte, 1)
	inspected := make(chan http.Header, 1)
	b, d := fixtureBridge(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Host != "clip.example.com" || r.ContentLength != int64(len(body)) {
			t.Errorf("unexpected host or size: %s %d", r.Host, r.ContentLength)
		}
		inspected <- r.Header.Clone()
		bytes, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read: %v", err)
		}
		received <- bytes
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Set-Cookie", "must-not-forward=1")
		w.Header().Set("Content-Range", "bytes 0-9/10")
		w.WriteHeader(201)
		_, _ = w.Write(response)
	})
	incomingFrame(b, wireFrame{Type: "request", Method: "POST", Path: "/api/items/file", BodySize: int64(len(body)), Headers: map[string]string{
		"cookie": "clip_session=forged", "host": "evil.example", "authorization": "Bearer evil", "x-clip-request": "0", "range": "bytes=0-9", "x-clip-file-name": "example.bin", "content-type": "application/octet-stream",
	}})
	var uploadCredit atomic.Int64
	uploadCredit.Store(creditWindow)
	uploadDone := make(chan struct{})
	go func() {
		defer close(uploadDone)
		for offset := 0; offset < len(body); {
			n := min(chunkSize, len(body)-offset)
			if uploadCredit.Load() < int64(n) {
				select {
				case <-b.ctx.Done():
					return
				case <-time.After(time.Millisecond):
				}
				continue
			}
			uploadCredit.Add(-int64(n))
			b.onMessage(webrtc.DataChannelMessage{Data: body[offset : offset+n]})
			offset += n
		}
		incomingFrame(b, wireFrame{Type: "end"})
	}()
	var downloaded bytes.Buffer
	timer := time.NewTimer(10 * time.Second)
	defer timer.Stop()
	finished := false
	for !finished {
		select {
		case msg := <-d.messages:
			if !msg.IsString {
				downloaded.Write(msg.Data)
				incomingFrame(b, wireFrame{Type: "credit", Bytes: int64(len(msg.Data))})
				continue
			}
			var f wireFrame
			if err := json.Unmarshal(msg.Data, &f); err != nil {
				t.Fatal(err)
			}
			switch f.Type {
			case "credit":
				uploadCredit.Add(f.Bytes)
			case "response":
				if f.Status != 201 || f.Headers["set-cookie"] != "" || f.Headers["content-range"] != "bytes 0-9/10" {
					t.Fatalf("bad response: %+v", f)
				}
			case "end":
				finished = true
			default:
				t.Fatalf("unexpected frame %+v", f)
			}
		case <-d.closed:
			t.Fatal("unexpected close")
		case <-timer.C:
			t.Fatal("stream timed out")
		}
	}
	<-uploadDone
	if got := <-received; sha256.Sum256(got) != sha256.Sum256(body) {
		t.Fatal("upload mismatch")
	}
	if sha256.Sum256(downloaded.Bytes()) != sha256.Sum256(response) {
		t.Fatal("download mismatch")
	}
	h := <-inspected
	if h.Get("Cookie") != "clip_session=original" || h.Get("Authorization") != "" || h.Get("X-Clip-Request") != "1" || h.Get("Range") != "bytes=0-9" || h.Get("X-Clip-File-Name") != "example.bin" {
		t.Fatalf("headers not filtered: %v", h)
	}
	select {
	case <-d.closed:
		t.Fatal("server closed before receiver acknowledged end")
	default:
	}
}

func TestRedirectNeverFollowed(t *testing.T) {
	var count atomic.Int64
	b, d := fixtureBridge(t, func(w http.ResponseWriter, r *http.Request) {
		count.Add(1)
		w.Header().Set("Location", "/api/auth/admin")
		w.WriteHeader(302)
	})
	incomingFrame(b, wireFrame{Type: "request", Method: "GET", Path: "/api/items"})
	incomingFrame(b, wireFrame{Type: "end"})
	select {
	case m := <-d.messages:
		var f wireFrame
		_ = json.Unmarshal(m.Data, &f)
		if f.Status != 302 {
			t.Fatalf("unexpected %+v", f)
		}
	case <-time.After(time.Second):
		t.Fatal("no response")
	}
	if count.Load() != 1 {
		t.Fatal("redirect followed")
	}
}

func TestBackendRejectsRevokedSessionBeforeUploadCompletes(t *testing.T) {
	b, d := fixtureBridge(t, func(w http.ResponseWriter, r *http.Request) {
		// A peer retains the signaling identity, but current authorization still
		// belongs to the backend. A browser cannot substitute another session.
		if r.Header.Get("Cookie") != "clip_session=original" {
			t.Errorf("trusted session was replaced: %q", r.Header.Get("Cookie"))
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, `{"error":"session expired"}`)
	})
	incomingFrame(b, wireFrame{Type: "request", Method: "POST", Path: "/api/items/file", BodySize: 4 * creditWindow,
		Headers: map[string]string{"cookie": "clip_session=forged"}})
	// Do not send the body or end frame: rejection must reach the browser without
	// forcing it to finish a large upload that cannot be accepted.
	status := 0
	var body bytes.Buffer
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	for {
		select {
		case msg := <-d.messages:
			if !msg.IsString {
				body.Write(msg.Data)
				continue
			}
			var f wireFrame
			if err := json.Unmarshal(msg.Data, &f); err != nil {
				t.Fatal(err)
			}
			switch f.Type {
			case "response":
				status = f.Status
			case "end":
				if status != http.StatusUnauthorized || body.String() != `{"error":"session expired"}` {
					t.Fatalf("unexpected rejection: %d %s", status, body.String())
				}
				return
			default:
				t.Fatalf("unexpected response: %+v", f)
			}
		case <-d.closed:
			t.Fatal("rejection was discarded")
		case <-timer.C:
			t.Fatal("backend rejection waited for upload body")
		}
	}
}

func TestDisconnectedWriteDoesNotReportSuccessfulSave(t *testing.T) {
	b, d := fixtureBridge(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		connection, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		_ = connection.Close()
	})
	incomingFrame(b, wireFrame{Type: "request", Method: "POST", Path: "/api/items/text", BodySize: 2})
	b.onMessage(webrtc.DataChannelMessage{Data: []byte("{}")})
	incomingFrame(b, wireFrame{Type: "end"})
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	for {
		select {
		case msg := <-d.messages:
			var f wireFrame
			if !msg.IsString || json.Unmarshal(msg.Data, &f) != nil {
				t.Fatal("unexpected binary response")
			}
			if f.Type == "credit" {
				continue
			}
			if f.Type != "error" || !strings.Contains(f.Message, "completion is unknown") || strings.Contains(f.Message, "127.0.0.1") || strings.Contains(f.Message, "clip_session") {
				t.Fatalf("write failure must remain ambiguous without leaking backend details: %+v", f)
			}
			return
		case <-timer.C:
			t.Fatal("disconnected write did not finish")
		}
	}
}

func TestSSEStreamsBeforeBackendClosesAndCancels(t *testing.T) {
	canceled := make(chan struct{})
	b, d := fixtureBridge(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "event: ready\ndata: {}\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(canceled)
	})
	incomingFrame(b, wireFrame{Type: "request", Method: "GET", Path: "/api/events"})
	incomingFrame(b, wireFrame{Type: "end"})
	for {
		select {
		case m := <-d.messages:
			if !m.IsString {
				if !strings.Contains(string(m.Data), "event: ready") {
					t.Fatal("bad event")
				}
				b.close()
				select {
				case <-canceled:
					return
				case <-time.After(time.Second):
					t.Fatal("backend not canceled")
				}
			}
		case <-time.After(time.Second):
			t.Fatal("SSE buffered")
		}
	}
}

func TestCreditAndProtocolLimitsCloseChannel(t *testing.T) {
	for _, name := range []string{"oversize", "credit-inflation", "body-overrun", "early-end", "duplicate-request", "forbidden-path"} {
		t.Run(name, func(t *testing.T) {
			b, d := fixtureBridge(t, func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() })
			if name == "forbidden-path" {
				incomingFrame(b, wireFrame{Type: "request", Method: "POST", Path: "/api/auth/login"})
			} else {
				incomingFrame(b, wireFrame{Type: "request", Method: "POST", Path: "/api/items/file", BodySize: 2})
				switch name {
				case "oversize":
					b.onMessage(webrtc.DataChannelMessage{Data: make([]byte, chunkSize+1)})
				case "credit-inflation":
					incomingFrame(b, wireFrame{Type: "credit", Bytes: 1})
				case "body-overrun":
					b.onMessage(webrtc.DataChannelMessage{Data: []byte("abc")})
				case "early-end":
					incomingFrame(b, wireFrame{Type: "end"})
				case "duplicate-request":
					incomingFrame(b, wireFrame{Type: "request", Method: "GET", Path: "/api/items"})
				}
			}
			select {
			case <-d.closed:
			case <-time.After(time.Second):
				t.Fatal("invalid peer retained")
			}
		})
	}
}

func TestSenderWaitsForCreditAndBufferedAmount(t *testing.T) {
	b, d := fixtureBridge(t, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })
	b.mu.Lock()
	b.started = true
	b.sendCredit = 0
	b.mu.Unlock()
	d.buffered.Store(bufferLimit)
	done := make(chan error, 1)
	go func() { done <- b.send([]byte("data"), false) }()
	select {
	case <-done:
		t.Fatal("sent without capacity")
	case <-time.After(30 * time.Millisecond):
	}
	incomingFrame(b, wireFrame{Type: "credit", Bytes: 4})
	select {
	case <-done:
		t.Fatal("ignored buffered limit")
	case <-time.After(30 * time.Millisecond):
	}
	d.buffered.Store(0)
	b.signal()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("did not wake")
	}
}

func TestIdleAndUnstartedChannelsExpire(t *testing.T) {
	b, d := fixtureBridge(t, func(w http.ResponseWriter, r *http.Request) {})
	b.activity.Store(time.Now().Add(-firstMessageTimeout - time.Second).UnixNano())
	select {
	case <-d.closed:
	case <-time.After(2 * time.Second):
		t.Fatal("unstarted channel leaked")
	}
}
