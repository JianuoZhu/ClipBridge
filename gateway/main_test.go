package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

func TestSignalingAuthenticationAndInputLimits(t *testing.T) {
	secret := strings.Repeat("a", 32)
	g := newGateway(config{secret: secret}, nil)
	defer g.close()
	for _, tc := range []struct {
		name, method, path, auth, body string
		status                         int
	}{
		{"missing auth", "POST", "/offer", "", "{}", 401},
		{"wrong auth", "POST", "/offer", "Bearer wrong", "{}", 401},
		{"wrong path", "POST", "/api/items", "Bearer " + secret, "{}", 404},
		{"wrong method", "GET", "/offer", "Bearer " + secret, "{}", 404},
		{"empty offer", "POST", "/offer", "Bearer " + secret, "{}", 400},
		{"oversize", "POST", "/offer", "Bearer " + secret, strings.Repeat("x", 129*1024), 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			req.Header.Set("Authorization", tc.auth)
			res := httptest.NewRecorder()
			g.ServeHTTP(res, req)
			if res.Code != tc.status {
				t.Fatalf("got %d want %d", res.Code, tc.status)
			}
		})
	}
}

func TestInvalidAndExpiredIdentities(t *testing.T) {
	base := offerRequest{Offer: webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: "v=0"}, Cookie: "clip_session=abc", Host: "clip.example.com", ExpiresAt: time.Now().Add(time.Minute).UnixMilli()}
	if !validOffer(base) {
		t.Fatal("rejected valid identity")
	}
	for _, mutate := range []func(*offerRequest){func(i *offerRequest) { i.ExpiresAt = 0 }, func(i *offerRequest) { i.Cookie = "abc\r\nInjected: bad" }, func(i *offerRequest) { i.Host = "evil/path" }, func(i *offerRequest) { i.Offer.Type = webrtc.SDPTypeAnswer }, func(i *offerRequest) { i.Offer.SDP = strings.Repeat("x", 64*1024+1) }} {
		i := base
		mutate(&i)
		if validOffer(i) {
			t.Fatal("accepted invalid identity")
		}
	}
}

func TestPeerCapacityRejectsBeforeAllocating(t *testing.T) {
	secret := strings.Repeat("a", 32)
	g := newGateway(config{secret: secret}, nil)
	defer g.close()
	g.reserved = maxPeers
	body, _ := json.Marshal(offerRequest{Offer: webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: "v=0"}, Cookie: "clip_session=abc", Host: "clip.example.com", ExpiresAt: time.Now().Add(time.Minute).UnixMilli()})
	req := httptest.NewRequest(http.MethodPost, "/offer", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+secret)
	res := httptest.NewRecorder()
	g.ServeHTTP(res, req)
	if res.Code != 503 {
		t.Fatalf("got %d", res.Code)
	}
}

func TestConfigRejectsUnsafeCredentialsAndOrigins(t *testing.T) {
	t.Setenv("CLIP_P2P_SECRET", strings.Repeat("a", 32))
	t.Setenv("CLIP_P2P_BACKEND_URL", "http://127.0.0.1:8080")
	t.Setenv("CLIP_P2P_STUN_URLS", "stun:example.com:3478")
	t.Setenv("CLIP_P2P_UDP_PORT", "50000")
	t.Setenv("CLIP_P2P_ADVERTISE_IPS", "")
	if _, err := readConfig(); err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{"file:///etc/passwd", "http://user:password@example.com", "http://localhost/path", "http://localhost?query=1"} {
		t.Setenv("CLIP_P2P_BACKEND_URL", value)
		if _, err := readConfig(); err == nil {
			t.Fatalf("accepted %s", value)
		}
	}
	t.Setenv("CLIP_P2P_BACKEND_URL", "http://127.0.0.1:8080")
	t.Setenv("CLIP_P2P_SECRET", "short")
	if _, err := readConfig(); err == nil {
		t.Fatal("accepted short secret")
	}
}

func TestSTUNConfigurationPreservesEmptyAndMatchesBrowserLimit(t *testing.T) {
	t.Setenv("CLIP_P2P_SECRET", strings.Repeat("a", 32))
	t.Setenv("CLIP_P2P_BACKEND_URL", "http://127.0.0.1:8080")
	t.Setenv("CLIP_P2P_UDP_PORT", "50000")
	t.Setenv("CLIP_P2P_ADVERTISE_IPS", "")
	// Setenv registers cleanup before temporarily removing the variable, so the
	// caller's configuration is restored even when this test fails.
	t.Setenv("CLIP_P2P_STUN_URLS", "")
	if err := os.Unsetenv("CLIP_P2P_STUN_URLS"); err != nil {
		t.Fatal(err)
	}
	c, err := readConfig()
	if err != nil || len(c.stun) != 2 {
		t.Fatalf("unset must use defaults: %v %v", c.stun, err)
	}
	t.Setenv("CLIP_P2P_STUN_URLS", "")
	c, err = readConfig()
	if err != nil || len(c.stun) != 0 {
		t.Fatalf("explicit empty must disable STUN: %v %v", c.stun, err)
	}
	t.Setenv("CLIP_P2P_STUN_URLS", strings.Repeat("stun:example.com:3478,", 8))
	c, err = readConfig()
	if err != nil || len(c.stun) != 8 {
		t.Fatalf("eight STUN servers must be accepted: %v %v", c.stun, err)
	}
	t.Setenv("CLIP_P2P_STUN_URLS", strings.Repeat("stun:example.com:3478,", 9))
	if _, err := readConfig(); err == nil {
		t.Fatal("accepted more than eight STUN servers")
	}
}
