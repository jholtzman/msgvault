package gmessagesweb

import (
	"bytes"
	"strings"
)

// videoExtensions maps each video type a capture file may list to the
// extension used for the stored attachment's name.
var videoExtensions = map[string]string{
	"video/mp4":       "mp4",
	"video/quicktime": "mov",
	"video/3gpp":      "3gp",
	"video/webm":      "webm",
}

// sniffVideo names the video type b starts with, or returns "" for
// anything else. A video is stored only when its bytes match the type its
// capture record names.
func sniffVideo(b []byte) string {
	switch {
	case len(b) >= 12 && string(b[4:8]) == "ftyp":
		// ISO base media files name their major brand after "ftyp".
		brand := string(b[8:12])
		switch {
		case brand == "qt  ":
			return "video/quicktime"
		case strings.HasPrefix(brand, "3gp"), strings.HasPrefix(brand, "3gg"),
			strings.HasPrefix(brand, "3ge"), strings.HasPrefix(brand, "3gs"):
			return "video/3gpp"
		case strings.HasPrefix(brand, "iso"), strings.HasPrefix(brand, "mp4"),
			brand == "avc1", brand == "M4V ", brand == "mmp4", brand == "MSNV",
			brand == "dash", brand == "f4v ":
			return "video/mp4"
		}
	case bytes.HasPrefix(b, []byte{0x1A, 0x45, 0xDF, 0xA3}):
		// An EBML header, which Matroska shares; the DocType says which.
		if bytes.Contains(b[:min(len(b), 64)], []byte("webm")) {
			return "video/webm"
		}
	}
	return ""
}

func isVideo(mimeType string) bool {
	return videoExtensions[mimeType] != ""
}
