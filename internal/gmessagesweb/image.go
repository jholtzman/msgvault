package gmessagesweb

import "bytes"

// imageExtensions maps each image type a capture file may list to the
// extension used for the stored attachment's name.
var imageExtensions = map[string]string{
	"image/jpeg": "jpg",
	"image/png":  "png",
	"image/gif":  "gif",
	"image/webp": "webp",
	"image/heic": "heic",
	"image/heif": "heif",
	"image/avif": "avif",
}

// sniffImage names the image type b starts with, or returns "" for
// anything else. An attachment is stored only when its bytes match the type
// its capture record names.
func sniffImage(b []byte) string {
	switch {
	case bytes.HasPrefix(b, []byte{0xFF, 0xD8, 0xFF}):
		return "image/jpeg"
	case bytes.HasPrefix(b, []byte("\x89PNG\r\n\x1a\n")):
		return "image/png"
	case bytes.HasPrefix(b, []byte("GIF87a")), bytes.HasPrefix(b, []byte("GIF89a")):
		return "image/gif"
	case len(b) >= 12 && string(b[0:4]) == "RIFF" && string(b[8:12]) == "WEBP":
		return "image/webp"
	case len(b) >= 12 && string(b[4:8]) == "ftyp":
		// ISO base media files name their major brand after "ftyp".
		switch string(b[8:12]) {
		case "heic", "heix", "hevc", "hevx", "heim", "heis":
			return "image/heic"
		case "mif1", "msf1":
			return "image/heif"
		case "avif", "avis":
			return "image/avif"
		}
	}
	return ""
}
