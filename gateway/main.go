package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/webrtc/v4"
)

const maxPeers = 64

type config struct {
	listen, secret  string
	backend         *url.URL
	udpPort         int
	stun, advertise []string
}

func envOr(key, value string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return value
}
func commaList(value string) []string {
	var result []string
	for _, v := range strings.Split(value, ",") {
		if v = strings.TrimSpace(v); v != "" {
			result = append(result, v)
		}
	}
	return result
}

func readConfig() (config, error) {
	stunURLs, stunConfigured := os.LookupEnv("CLIP_P2P_STUN_URLS")
	if !stunConfigured {
		stunURLs = "stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302"
	}
	c := config{listen: envOr("CLIP_P2P_LISTEN", "127.0.0.1:8090"), secret: os.Getenv("CLIP_P2P_SECRET"),
		stun: commaList(stunURLs), advertise: commaList(os.Getenv("CLIP_P2P_ADVERTISE_IPS"))}
	if len(c.secret) < 32 || len(c.secret) > 512 || strings.ContainsAny(c.secret, "\r\n") {
		return c, errors.New("CLIP_P2P_SECRET must contain 32 to 512 characters")
	}
	var err error
	c.backend, err = url.Parse(envOr("CLIP_P2P_BACKEND_URL", "http://127.0.0.1:8080"))
	if err != nil || (c.backend.Scheme != "http" && c.backend.Scheme != "https") || c.backend.Host == "" || c.backend.User != nil || c.backend.RawQuery != "" || c.backend.Fragment != "" || (c.backend.Path != "" && c.backend.Path != "/") {
		return c, errors.New("CLIP_P2P_BACKEND_URL must be an HTTP(S) origin")
	}
	c.udpPort, err = strconv.Atoi(envOr("CLIP_P2P_UDP_PORT", "50000"))
	if err != nil || c.udpPort < 1 || c.udpPort > 65535 {
		return c, errors.New("invalid CLIP_P2P_UDP_PORT")
	}
	if len(c.stun) > 8 {
		return c, errors.New("at most eight STUN servers are supported")
	}
	for _, server := range c.stun {
		if !strings.HasPrefix(server, "stun:") || len(server) > 256 {
			return c, errors.New("only stun: URLs are supported; use HTTPS fallback when direct ICE fails")
		}
	}
	if len(c.advertise) > 8 {
		return c, errors.New("at most eight advertised IPv4 addresses are supported")
	}
	for _, ip := range c.advertise {
		if parsed := net.ParseIP(ip); parsed == nil || parsed.To4() == nil || parsed.IsUnspecified() || parsed.IsMulticast() {
			return c, errors.New("CLIP_P2P_ADVERTISE_IPS must contain IPv4 addresses")
		}
	}
	return c, nil
}

func createAPI(c config) (*webrtc.API, io.Closer, error) {
	mux, err := ice.NewMultiUDPMuxFromPort(c.udpPort, ice.UDPMuxFromPortWithNetworks(ice.NetworkTypeUDP4))
	if err != nil {
		return nil, nil, err
	}
	settings := webrtc.SettingEngine{}
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	settings.SetICEUDPMux(mux)
	settings.SetSTUNGatherTimeout(4 * time.Second)
	settings.SetICETimeouts(10*time.Second, 20*time.Second, 2*time.Second)
	settings.SetSCTPMaxMessageSize(chunkSize)
	settings.SetSCTPMaxReceiveBufferSize(4 * creditWindow)
	if len(c.advertise) > 0 {
		settings.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
		settings.SetNAT1To1IPs(c.advertise, webrtc.ICECandidateTypeHost)
	}
	return webrtc.NewAPI(webrtc.WithSettingEngine(settings)), mux, nil
}

type gateway struct {
	config   config
	api      *webrtc.API
	client   *http.Client
	ctx      context.Context
	cancel   context.CancelFunc
	mu       sync.Mutex
	peers    map[*webrtc.PeerConnection]context.CancelFunc
	reserved int
	requests chan struct{}
}

func newGateway(c config, api *webrtc.API) *gateway {
	ctx, cancel := context.WithCancel(context.Background())
	return &gateway{config: c, api: api, ctx: ctx, cancel: cancel, peers: make(map[*webrtc.PeerConnection]context.CancelFunc), requests: make(chan struct{}, maxGlobalRequests),
		client: &http.Client{Transport: &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
			MaxConnsPerHost: maxGlobalRequests, MaxIdleConns: 32, MaxIdleConnsPerHost: 32, IdleConnTimeout: 60 * time.Second,
			ResponseHeaderTimeout: 30 * time.Second, MaxResponseHeaderBytes: 32 * 1024, DisableCompression: true},
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

func (g *gateway) close() { g.cancel(); g.client.CloseIdleConnections() }

type offerRequest struct {
	Offer     webrtc.SessionDescription `json:"offer"`
	Cookie    string                    `json:"cookie"`
	Host      string                    `json:"host"`
	ExpiresAt int64                     `json:"expiresAt"`
}

func validOffer(input offerRequest) bool {
	return input.Offer.Type == webrtc.SDPTypeOffer && len(input.Offer.SDP) > 0 && len(input.Offer.SDP) <= 64*1024 &&
		strings.Count(input.Offer.SDP, "a=candidate:") <= 128 && len(input.Cookie) > 0 && len(input.Cookie) <= 8192 &&
		len(input.Host) > 0 && len(input.Host) <= 255 && !strings.ContainsAny(input.Cookie+input.Host, "\r\n\x00") &&
		!strings.ContainsAny(input.Host, " /\\@") && input.ExpiresAt > time.Now().UnixMilli()
}

func (g *gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != "POST" || r.URL.Path != "/offer" || r.URL.RawQuery != "" {
		http.NotFound(w, r)
		return
	}
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+g.config.secret)) != 1 {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 128*1024)
	var input offerRequest
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil || !validOffer(input) {
		http.Error(w, "Invalid offer", 400)
		return
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		http.Error(w, "Invalid offer", 400)
		return
	}
	g.mu.Lock()
	if g.reserved >= maxPeers || g.ctx.Err() != nil {
		g.mu.Unlock()
		http.Error(w, "Gateway busy", 503)
		return
	}
	g.reserved++
	g.mu.Unlock()
	reserved := true
	defer func() {
		if reserved {
			g.mu.Lock()
			g.reserved--
			g.mu.Unlock()
		}
	}()
	servers := []webrtc.ICEServer{}
	if len(g.config.stun) > 0 {
		servers = append(servers, webrtc.ICEServer{URLs: g.config.stun})
	}
	pc, err := g.api.NewPeerConnection(webrtc.Configuration{ICEServers: servers})
	if err != nil {
		http.Error(w, "Unable to allocate peer", 503)
		return
	}
	expiry := time.UnixMilli(input.ExpiresAt)
	if max := time.Now().Add(30 * time.Minute); expiry.After(max) {
		expiry = max
	}
	ctx, cancel := context.WithDeadline(g.ctx, expiry)
	g.mu.Lock()
	g.peers[pc] = cancel
	g.mu.Unlock()
	reserved = false
	var cleanup sync.Once
	closePeer := func() {
		cleanup.Do(func() {
			cancel()
			_ = pc.Close()
			g.mu.Lock()
			delete(g.peers, pc)
			g.reserved--
			g.mu.Unlock()
		})
	}
	context.AfterFunc(ctx, closePeer)
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			cancel()
		}
	})
	// Failed or abandoned handshakes must not occupy a slot for the entire TTL.
	handshakeTimer := time.AfterFunc(30*time.Second, func() {
		if pc.ConnectionState() != webrtc.PeerConnectionStateConnected {
			cancel()
		}
	})
	context.AfterFunc(ctx, func() { handshakeTimer.Stop() })
	var peerMu sync.Mutex
	requestCount := 0
	controlSeen := false
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		if dc.Label() == "clip-control-v1" {
			peerMu.Lock()
			duplicate := controlSeen
			controlSeen = true
			peerMu.Unlock()
			if duplicate {
				_ = dc.Close()
				return
			}
			dc.OnClose(cancel)
			dc.OnMessage(func(webrtc.DataChannelMessage) { cancel() })
			return
		}
		if dc.Label() != "clip-http-v1" || !dc.Ordered() || dc.MaxRetransmits() != nil || dc.MaxPacketLifeTime() != nil {
			_ = dc.Close()
			return
		}
		peerMu.Lock()
		if requestCount >= maxRequestChannels || !controlSeen || ctx.Err() != nil {
			peerMu.Unlock()
			_ = dc.Close()
			return
		}
		select {
		case g.requests <- struct{}{}:
		default:
			peerMu.Unlock()
			_ = dc.Close()
			return
		}
		requestCount++
		peerMu.Unlock()
		b := newBridge(ctx, dc, g.client, g.config.backend, identity{cookie: input.Cookie, host: input.Host}, func() {
			peerMu.Lock()
			requestCount--
			peerMu.Unlock()
			<-g.requests
		})
		dc.SetBufferedAmountLowThreshold(bufferLimit / 2)
		dc.OnBufferedAmountLow(b.signal)
		dc.OnClose(b.close)
		dc.OnError(func(error) { b.close() })
		dc.OnMessage(b.onMessage)
	})
	if err = pc.SetRemoteDescription(input.Offer); err != nil {
		cancel()
		http.Error(w, "Invalid WebRTC offer", 400)
		return
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		cancel()
		http.Error(w, "Unable to create answer", 400)
		return
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err = pc.SetLocalDescription(answer); err != nil {
		cancel()
		http.Error(w, "Unable to set answer", 500)
		return
	}
	timer := time.NewTimer(6 * time.Second)
	defer timer.Stop()
	select {
	case <-gathered:
	case <-timer.C:
		cancel()
		http.Error(w, "ICE gathering timed out", 504)
		return
	case <-r.Context().Done():
		cancel()
		return
	case <-ctx.Done():
		http.Error(w, "Peer expired", 408)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if err = json.NewEncoder(w).Encode(map[string]any{"answer": pc.LocalDescription()}); err != nil {
		cancel()
	}
}

func main() {
	c, err := readConfig()
	if err != nil {
		log.Fatal(err)
	}
	api, mux, err := createAPI(c)
	if err != nil {
		log.Fatal(err)
	}
	defer mux.Close()
	g := newGateway(c, api)
	defer g.close()
	server := &http.Server{Addr: c.listen, Handler: g, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 12 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16 * 1024}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		g.close()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	fmt.Printf("ClipBridge WebRTC gateway signaling on %s; direct UDP port %d\n", c.listen, c.udpPort)
	if err = server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
