package main

import (
	"bytes"
	"crypto/subtle"
	"encoding/json"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
)

// 결과 GIF 하나의 상한. 이보다 크면 애초에 GIF로 쓸 수 없는 크기다.
const maxSaveBytes = 1 << 30

// 외부로 나가는 연결을 페이지 수준에서 아예 막는다. 글꼴·스크립트·이미지 모두 이 프로그램 안에서만 온다.
const contentSecurityPolicy = "default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self'; " +
	"font-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' blob:; " +
	"base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

// Windows 레지스트리에 따라 .js 가 text/plain 으로 잡히는 PC가 있어서, 쓰는 형식은 직접 정해 둔다.
var contentTypes = map[string]string{
	".html":  "text/html; charset=utf-8",
	".js":    "text/javascript; charset=utf-8",
	".css":   "text/css; charset=utf-8",
	".svg":   "image/svg+xml",
	".woff2": "font/woff2",
	".txt":   "text/plain; charset=utf-8",
	".md":    "text/plain; charset=utf-8",
}

type saveDialogFunc func(suggested string) (path string, ok bool, err error)

type server struct {
	addr       string
	token      string
	files      fs.FS
	saveDialog saveDialogFunc

	mu        sync.Mutex
	lastSaved string
}

func (s *server) handler() http.Handler {
	static := http.FileServer(http.FS(s.files))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 다른 사이트가 DNS를 바꿔 이 주소로 들어오는 경우(DNS 리바인딩)를 막는다.
		if r.Host != s.addr {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		header := w.Header()
		header.Set("Cache-Control", "no-cache")
		header.Set("X-Content-Type-Options", "nosniff")
		header.Set("Content-Security-Policy", contentSecurityPolicy)

		if r.URL.Path == "/save" {
			s.save(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		name := r.URL.Path
		if strings.HasSuffix(name, "/") {
			name += "index.html"
		}
		if contentType, ok := contentTypes[path.Ext(name)]; ok {
			header.Set("Content-Type", contentType)
		}
		static.ServeHTTP(w, r)
	})
}

func (s *server) save(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// 토큰은 프로그램 창에만 심어 둔다. 다른 프로그램이나 웹 페이지가 이 주소로 파일을 쓰게 만들 수 없다.
	if s.saveDialog == nil || subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Desktop-Token")), []byte(s.token)) != 1 {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxSaveBytes))
	if err != nil {
		http.Error(w, "GIF 데이터를 받지 못했어요.", http.StatusBadRequest)
		return
	}
	if !bytes.HasPrefix(data, []byte("GIF8")) {
		http.Error(w, "GIF 파일만 저장할 수 있어요.", http.StatusBadRequest)
		return
	}

	target, ok, err := s.saveDialog(safeFileName(r.URL.Query().Get("name")))
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if !ok {
		writeJSON(w, map[string]any{"cancelled": true})
		return
	}
	if err := os.WriteFile(target, data, 0o644); err != nil {
		http.Error(w, "파일을 쓰지 못했어요. 다른 폴더를 골라 보세요.", http.StatusInternalServerError)
		return
	}

	s.mu.Lock()
	s.lastSaved = target
	s.mu.Unlock()
	writeJSON(w, map[string]any{"path": target})
}

func (s *server) lastSavedPath() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastSaved
}

// 저장 창에 미리 넣어 둘 이름. 경로나 Windows 금지 문자가 섞여 들어오지 않게 다듬는다.
func safeFileName(name string) string {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.Map(func(r rune) rune {
		if r < 0x20 || strings.ContainsRune(`<>:"/\|?*`, r) {
			return -1
		}
		return r
	}, name)
	name = strings.Trim(name, " .")
	if name == "" {
		name = "video"
	}
	if !strings.EqualFold(filepath.Ext(name), ".gif") {
		name += ".gif"
	}
	return name
}

func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(value)
}
