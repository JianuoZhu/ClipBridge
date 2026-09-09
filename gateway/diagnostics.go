package main

import (
	"fmt"
	"strings"
)

// Count only fixed candidate type names. Never put SDP, addresses, credentials,
// browser-controlled values, or raw Pion errors in our diagnostic log fields.
func candidateTypeSummary(sdp string) string {
	counts := map[string]int{"host": 0, "srflx": 0, "prflx": 0, "relay": 0, "other": 0}
	for _, line := range strings.Split(sdp, "\n") {
		if !strings.HasPrefix(line, "a=candidate:") {
			continue
		}
		fields := strings.Fields(line)
		kind := "other"
		// The candidate grammar has eight mandatory fields; extension values
		// containing the word "typ" must not change its type classification.
		if len(fields) >= 8 && fields[6] == "typ" {
			if _, known := counts[fields[7]]; known {
				kind = fields[7]
			}
		}
		counts[kind]++
	}
	return fmt.Sprintf("host:%d,srflx:%d,prflx:%d,relay:%d,other:%d", counts["host"], counts["srflx"], counts["prflx"], counts["relay"], counts["other"])
}
