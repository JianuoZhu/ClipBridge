package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net"
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

// Real DTLS/SCTP DataChannels exercise framing and backpressure beyond the
// initial credit window, independently of public STUN servers or Internet access.
func TestRealWebRTCUploadAndDownload(t *testing.T) {
	content := bytes.Repeat([]byte("0123456789abcdef"), 150000)
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Cookie") != "session=trusted" || r.Header.Get("X-Clip-Request") != "1" {
			w.WriteHeader(401)
			return
		}
		got, err := io.ReadAll(r.Body)
		if err != nil || sha256.Sum256(got) != sha256.Sum256(content) {
			w.WriteHeader(400)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.WriteHeader(201)
		_, _ = w.Write(got)
	}))
	defer backend.Close()
	u, _ := url.Parse(backend.URL)
	settings := webrtc.SettingEngine{}
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	settings.SetIPFilter(func(ip net.IP) bool { return ip.IsLoopback() })
	api := webrtc.NewAPI(webrtc.WithSettingEngine(settings))
	g := newGateway(config{secret: strings.Repeat("a", 32), backend: u}, api)
	defer g.close()
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	control, err := pc.CreateDataChannel("clip-control-v1", nil)
	if err != nil {
		t.Fatal(err)
	}
	connected := make(chan struct{})
	control.OnOpen(func() { close(connected) })
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err = pc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gathered:
	case <-time.After(5 * time.Second):
		t.Fatal("offer gathering timeout")
	}
	payload, _ := json.Marshal(offerRequest{Offer: *pc.LocalDescription(), Cookie: "session=trusted", Host: "clip.example.com", ExpiresAt: time.Now().Add(time.Minute).UnixMilli()})
	req := httptest.NewRequest(http.MethodPost, "/offer", bytes.NewReader(payload))
	req.Header.Set("Authorization", "Bearer "+g.config.secret)
	res := httptest.NewRecorder()
	g.ServeHTTP(res, req)
	if res.Code != 200 {
		t.Fatalf("offer failed: %d %s", res.Code, res.Body.String())
	}
	var answer struct {
		Answer webrtc.SessionDescription `json:"answer"`
	}
	if err = json.Unmarshal(res.Body.Bytes(), &answer); err != nil {
		t.Fatal(err)
	}
	if err = pc.SetRemoteDescription(answer.Answer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-connected:
	case <-time.After(8 * time.Second):
		t.Fatal("connection timed out")
	}
	dc, err := pc.CreateDataChannel("clip-http-v1", nil)
	if err != nil {
		t.Fatal(err)
	}
	var credit atomic.Int64
	credit.Store(creditWindow)
	var received bytes.Buffer
	var receivedMu sync.Mutex
	result := make(chan error, 1)
	finish := func(err error) {
		select {
		case result <- err:
		default:
		}
	}
	dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		if !msg.IsString {
			receivedMu.Lock()
			received.Write(msg.Data)
			receivedMu.Unlock()
			f, _ := json.Marshal(wireFrame{Type: "credit", Bytes: int64(len(msg.Data))})
			if err := dc.SendText(string(f)); err != nil {
				finish(err)
			}
			return
		}
		var frame wireFrame
		if err := json.Unmarshal(msg.Data, &frame); err != nil {
			finish(err)
			return
		}
		switch frame.Type {
		case "credit":
			credit.Add(frame.Bytes)
		case "response":
			if frame.Status != 201 {
				finish(fmt.Errorf("status %d", frame.Status))
			}
		case "end":
			finish(nil)
		default:
			finish(fmt.Errorf("unexpected %s", frame.Type))
		}
	})
	dc.OnOpen(func() {
		f, _ := json.Marshal(wireFrame{Type: "request", Method: "POST", Path: "/api/items/file", Headers: map[string]string{"content-type": "application/octet-stream"}, BodySize: int64(len(content))})
		if err := dc.SendText(string(f)); err != nil {
			finish(err)
			return
		}
		deadline := time.Now().Add(10 * time.Second)
		for offset := 0; offset < len(content); {
			if time.Now().After(deadline) {
				finish(fmt.Errorf("upload timeout"))
				return
			}
			n := min(chunkSize, len(content)-offset)
			if credit.Load() < int64(n) || dc.BufferedAmount()+uint64(n) > bufferLimit {
				time.Sleep(time.Millisecond)
				continue
			}
			credit.Add(-int64(n))
			if err := dc.Send(content[offset : offset+n]); err != nil {
				finish(err)
				return
			}
			offset += n
		}
		if err := dc.SendText(`{"type":"end"}`); err != nil {
			finish(err)
		}
	})
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("transfer timeout")
	}
	receivedMu.Lock()
	defer receivedMu.Unlock()
	if sha256.Sum256(received.Bytes()) != sha256.Sum256(content) {
		t.Fatalf("received %d/%d bytes or corrupt content", received.Len(), len(content))
	}
	if err := dc.Close(); err != nil {
		t.Fatal(err)
	}
	if err := control.Close(); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		g.mu.Lock()
		released := g.reserved == 0 && len(g.peers) == 0
		g.mu.Unlock()
		if released && len(g.requests) == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("closing the control channel did not release the peer and requests")
		}
		time.Sleep(time.Millisecond)
	}
}
