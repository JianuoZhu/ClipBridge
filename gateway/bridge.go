package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v4"
)

const (
	chunkSize           = 16 * 1024
	creditWindow        = 1024 * 1024
	bufferLimit         = 512 * 1024
	maxRequestBody      = int64(1 << 40) // Backend applies the configured, usually much lower, quota.
	maxRequestChannels  = 32
	maxGlobalRequests   = 128
	firstMessageTimeout = 10 * time.Second
	idleTimeout         = 90 * time.Second
)

var errProtocol = errors.New("invalid transfer protocol")

// Authentication comes exclusively from the trusted signaling request. Each
// proxied request still passes through the backend's current session/role checks.
type identity struct{ cookie, host string }

type wireFrame struct {
	Type     string            `json:"type"`
	Method   string            `json:"method,omitempty"`
	Path     string            `json:"path,omitempty"`
	Headers  map[string]string `json:"headers,omitempty"`
	BodySize int64             `json:"bodySize"`
	Bytes    int64             `json:"bytes,omitempty"`
	Status   int               `json:"status,omitempty"`
	Message  string            `json:"message,omitempty"`
}

var fileRoute = regexp.MustCompile(`^/api/(items|library)/[0-9a-f-]{36}(?:/(file|preview|content))?$`)

func allowedRequest(method, path string, size int64) bool {
	if size < 0 || size > maxRequestBody || len(path) > 2048 || strings.ContainsAny(path, "\\#\r\n\x00") {
		return false
	}
	u, err := url.ParseRequestURI(path)
	if err != nil || u.IsAbs() || u.Host != "" || u.Opaque != "" || u.Path != u.EscapedPath() || strings.Contains(u.Path, "//") {
		return false
	}
	p := u.Path
	if (method == "GET" || method == "HEAD") && size != 0 {
		return false
	}
	switch p {
	case "/api/session", "/api/events", "/api/items":
		return method == "GET"
	case "/api/items/text", "/api/items/file":
		return method == "POST"
	case "/api/library":
		return method == "GET" || method == "POST"
	}
	m := fileRoute.FindStringSubmatch(p)
	if m == nil {
		return false
	}
	if m[2] == "file" || m[2] == "preview" {
		return method == "GET" || method == "HEAD"
	}
	if m[1] == "items" {
		return m[2] == "" && method == "DELETE"
	}
	if m[2] == "content" {
		return method == "GET"
	}
	return method == "GET" || method == "PATCH" || method == "DELETE"
}

var requestHeaders = map[string]bool{"range": true, "content-type": true, "x-clip-file-name": true}
var responseHeaders = map[string]bool{
	"content-type": true, "content-length": true, "content-range": true,
	"content-disposition": true, "accept-ranges": true, "cache-control": true,
	"etag": true, "last-modified": true, "content-encoding": true,
}

type dataChannel interface {
	Send([]byte) error
	SendText(string) error
	BufferedAmount() uint64
	Close() error
}

type bridge struct {
	ctx                                           context.Context
	cancel                                        context.CancelFunc
	dc                                            dataChannel
	client                                        *http.Client
	backend                                       *url.URL
	identity                                      identity
	release                                       func()
	closeOnce                                     sync.Once
	sendMu                                        sync.Mutex
	mu                                            sync.Mutex
	started, ended                                bool
	expected, received, receiveCredit, sendCredit int64
	reader                                        *io.PipeReader
	writer                                        *io.PipeWriter
	incoming                                      chan []byte
	wake                                          chan struct{}
	activity                                      atomic.Int64
}

func newBridge(parent context.Context, dc dataChannel, client *http.Client, backend *url.URL, user identity, release func()) *bridge {
	ctx, cancel := context.WithCancel(parent)
	b := &bridge{ctx: ctx, cancel: cancel, dc: dc, client: client, backend: backend, identity: user, release: release,
		receiveCredit: creditWindow, sendCredit: creditWindow, incoming: make(chan []byte, creditWindow/chunkSize+1), wake: make(chan struct{}, 1)}
	b.touch()
	go b.watch()
	return b
}

func (b *bridge) touch() { b.activity.Store(time.Now().UnixNano()) }
func (b *bridge) signal() {
	select {
	case b.wake <- struct{}{}:
	default:
	}
}
func (b *bridge) close() {
	b.closeOnce.Do(func() {
		b.cancel()
		b.mu.Lock()
		if b.reader != nil {
			_ = b.reader.CloseWithError(context.Canceled)
		}
		if b.writer != nil {
			_ = b.writer.CloseWithError(context.Canceled)
		}
		b.mu.Unlock()
		_ = b.dc.Close()
		if b.release != nil {
			b.release()
		}
	})
}

func (b *bridge) watch() {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	defer b.close()
	for {
		select {
		case <-b.ctx.Done():
			return
		case <-ticker.C:
			b.mu.Lock()
			started := b.started
			b.mu.Unlock()
			limit := idleTimeout
			if !started {
				limit = firstMessageTimeout
			}
			if time.Since(time.Unix(0, b.activity.Load())) > limit {
				return
			}
		}
	}
}

// Message callbacks never wait for disk/network IO. A peer cannot enqueue more
// than its explicit byte credit or the bounded frame queue.
func (b *bridge) onMessage(msg webrtc.DataChannelMessage) {
	if b.ctx.Err() != nil {
		return
	}
	if len(msg.Data) == 0 || len(msg.Data) > chunkSize {
		b.close()
		return
	}
	b.mu.Lock()
	if !msg.IsString {
		valid := b.started && !b.ended && int64(len(msg.Data)) <= b.receiveCredit && b.received+int64(len(msg.Data)) <= b.expected
		if valid {
			b.received += int64(len(msg.Data))
			b.receiveCredit -= int64(len(msg.Data))
			select {
			case b.incoming <- append([]byte(nil), msg.Data...):
			default:
				valid = false
			}
		}
		b.mu.Unlock()
		if !valid {
			b.close()
		} else {
			b.touch()
		}
		return
	}
	var frame wireFrame
	err := json.Unmarshal(msg.Data, &frame)
	if err != nil {
		b.mu.Unlock()
		b.close()
		return
	}
	switch frame.Type {
	case "request":
		valid := !b.started && allowedRequest(frame.Method, frame.Path, frame.BodySize) && len(frame.Headers) <= 16
		for k, v := range frame.Headers {
			if len(k) > 128 || len(v) > 8192 || strings.ContainsAny(k+v, "\r\n\x00") {
				valid = false
			}
		}
		if !valid {
			b.mu.Unlock()
			b.close()
			return
		}
		b.started = true
		b.expected = frame.BodySize
		b.reader, b.writer = io.Pipe()
		b.mu.Unlock()
		b.touch()
		go b.pumpUpload()
		go b.exchange(frame)
	case "end":
		valid := b.started && !b.ended && b.received == b.expected
		if valid {
			b.ended = true
			select {
			case b.incoming <- nil:
			default:
				valid = false
			}
		}
		b.mu.Unlock()
		if !valid {
			b.close()
		} else {
			b.touch()
		}
	case "credit":
		valid := b.started && frame.Bytes > 0 && frame.Bytes <= creditWindow && b.sendCredit+frame.Bytes <= creditWindow
		if valid {
			b.sendCredit += frame.Bytes
		}
		b.mu.Unlock()
		if !valid {
			b.close()
		} else {
			b.signal()
		}
	default:
		b.mu.Unlock()
		b.close()
	}
}

func (b *bridge) pumpUpload() {
	defer b.writer.Close()
	for {
		select {
		case <-b.ctx.Done():
			return
		case chunk := <-b.incoming:
			if chunk == nil {
				return
			}
			if _, err := b.writer.Write(chunk); err != nil {
				return
			}
			b.mu.Lock()
			b.receiveCredit += int64(len(chunk))
			b.mu.Unlock()
			if err := b.sendFrame(wireFrame{Type: "credit", Bytes: int64(len(chunk))}); err != nil {
				b.close()
				return
			}
		}
	}
}

func (b *bridge) sendFrame(frame wireFrame) error {
	bytes, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	return b.send(bytes, true)
}

func (b *bridge) send(bytes []byte, text bool) error {
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		if err := b.ctx.Err(); err != nil {
			return err
		}
		b.sendMu.Lock()
		b.mu.Lock()
		ready := b.dc.BufferedAmount()+uint64(len(bytes)) <= bufferLimit && (text || b.sendCredit >= int64(len(bytes)))
		if ready && !text {
			b.sendCredit -= int64(len(bytes))
		}
		b.mu.Unlock()
		if ready {
			var err error
			if text {
				err = b.dc.SendText(string(bytes))
			} else {
				err = b.dc.Send(bytes)
			}
			b.sendMu.Unlock()
			if err == nil {
				b.touch()
			}
			return err
		}
		b.sendMu.Unlock()
		select {
		case <-b.ctx.Done():
			return b.ctx.Err()
		case <-b.wake:
		case <-ticker.C:
		}
	}
}

func (b *bridge) exchange(frame wireFrame) {
	if err := b.forward(frame); err != nil && b.ctx.Err() == nil {
		// Do not expose private backend URLs, cookies, or library internals.
		_ = b.sendFrame(wireFrame{Type: "error", Message: "Home transfer failed; completion is unknown. Refresh before retrying a write."})
		b.close()
	}
}

func (b *bridge) forward(frame wireFrame) error {
	parsed, err := url.ParseRequestURI(frame.Path)
	if err != nil {
		return err
	}
	target := *b.backend
	target.Path = parsed.Path
	target.RawPath = ""
	target.RawQuery = parsed.RawQuery
	var body io.Reader = b.reader
	if frame.BodySize == 0 {
		body = nil
	}
	req, err := http.NewRequestWithContext(b.ctx, frame.Method, target.String(), body)
	if err != nil {
		return err
	}
	req.ContentLength = frame.BodySize
	req.Host = b.identity.host
	req.Header.Set("Cookie", b.identity.cookie)
	if frame.Method != "GET" && frame.Method != "HEAD" {
		req.Header.Set("X-Clip-Request", "1")
	}
	for k, v := range frame.Headers {
		if requestHeaders[strings.ToLower(k)] {
			req.Header.Set(k, v)
		}
	}
	res, err := b.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	// Stop consuming uploads when the backend rejects before the body completes.
	_ = b.reader.Close()
	headers := map[string]string{}
	for k, v := range res.Header {
		if responseHeaders[strings.ToLower(k)] {
			headers[strings.ToLower(k)] = strings.Join(v, ", ")
		}
	}
	if err = b.sendFrame(wireFrame{Type: "response", Status: res.StatusCode, Headers: headers}); err != nil {
		return err
	}
	buffer := make([]byte, chunkSize)
	for {
		n, readErr := res.Body.Read(buffer)
		if n > 0 {
			if err = b.send(buffer[:n], false); err != nil {
				return err
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return readErr
		}
	}
	// The browser closes only after receiving end; closing here can discard SCTP's
	// queued tail and turn a completed durable upload into an ambiguous failure.
	return b.sendFrame(wireFrame{Type: "end"})
}
