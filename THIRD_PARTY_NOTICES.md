# Third-party notices

ClipBridge's browser interface incorporates the following open-source projects. Exact versions are pinned in `package-lock.json`; complete license texts are retained in their distributed npm packages and source repositories.

- React and React DOM — MIT — https://github.com/facebook/react
- shadcn/ui design patterns — MIT — https://github.com/shadcn-ui/ui
- Radix UI Primitives and Radix Colors — MIT — https://github.com/radix-ui
- Lucide — ISC (some icons retain Feather's MIT notice) — https://github.com/lucide-icons/lucide
- Motion — MIT — https://github.com/motiondivision/motion
- React-PDF — MIT — https://github.com/wojtekmaj/react-pdf
- PDF.js — Apache-2.0 — https://github.com/mozilla/pdf.js
- react-zoom-pan-pinch — MIT — https://github.com/BetterTyped/react-zoom-pan-pinch
- Tailwind CSS — MIT — https://github.com/tailwindlabs/tailwindcss

The bundled PDF.js CMaps, standard fonts, and WASM codecs include their upstream license files in `dist/web/pdfjs/`.

The optional home WebRTC gateway uses Pion WebRTC and its Go dependencies. Exact versions are pinned in `gateway/go.mod` and `gateway/go.sum`.

- Pion WebRTC, ICE, DataChannel, SCTP, DTLS and related Pion packages — MIT — https://github.com/pion/webrtc
- Google UUID — BSD-3-Clause — https://github.com/google/uuid
- Go supplementary libraries (`golang.org/x/*`) — BSD-3-Clause — https://go.googlesource.com/

The gateway container includes the licenses of its Go module dependencies in `/usr/share/licenses/clip-p2p/`.
