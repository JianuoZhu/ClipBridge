package main

import "testing"

func TestCandidateDiagnosticsExcludeAddressesAndUnknownText(t *testing.T) {
	sdp := "v=0\r\na=ice-pwd:private-password\r\n" +
		"a=candidate:private-foundation 1 udp 1 192.168.1.7 50000 typ host\r\n" +
		"a=candidate:2 1 udp 1 203.0.113.1 12345 typ srflx raddr 192.168.1.7 rport 50000\r\n" +
		"a=candidate:3 1 udp 1 private-host.local 1 typ host typ relay\r\n" +
		"a=candidate:4 1 udp 1 203.0.113.2 1 typ private-injected-text\r\n" +
		"a=candidate:malformed\r\n"
	want := "host:2,srflx:1,prflx:0,relay:0,other:2"
	if got := candidateTypeSummary(sdp); got != want {
		t.Fatalf("got %q want %q", got, want)
	}
	if got := candidateTypeSummary(""); got != "host:0,srflx:0,prflx:0,relay:0,other:0" {
		t.Fatalf("empty SDP summary %q", got)
	}
}
