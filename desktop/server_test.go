package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

const testAddr = "127.0.0.1:47321"

func newTestServer(dialog saveDialogFunc) *server {
	return &server{
		addr:  testAddr,
		token: "secret",
		files: fstest.MapFS{
			"index.html": {Data: []byte("<!doctype html>")},
			"app.js":     {Data: []byte("export {}")},
		},
		saveDialog: dialog,
	}
}

func request(s *server, method, target, token, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "http://"+testAddr+target, strings.NewReader(body))
	if token != "" {
		req.Header.Set("X-Desktop-Token", token)
	}
	rec := httptest.NewRecorder()
	s.handler().ServeHTTP(rec, req)
	return rec
}

func TestServesPagesWithTypesAndPolicy(t *testing.T) {
	s := newTestServer(nil)
	for target, want := range map[string]string{"/": "text/html", "/app.js": "text/javascript"} {
		rec := request(s, http.MethodGet, target, "", "")
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status %d", target, rec.Code)
		}
		if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, want) {
			t.Errorf("%s: content type %q, want %q", target, got, want)
		}
		if !strings.Contains(rec.Header().Get("Content-Security-Policy"), "connect-src 'self' blob:") {
			t.Errorf("%s: missing CSP", target)
		}
	}
}

func TestRejectsOtherHosts(t *testing.T) {
	s := newTestServer(nil)
	req := httptest.NewRequest(http.MethodGet, "http://evil.example:47321/", nil)
	rec := httptest.NewRecorder()
	s.handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status %d, want 403", rec.Code)
	}
}

func TestSaveNeedsToken(t *testing.T) {
	called := false
	s := newTestServer(func(string) (string, bool, error) { called = true; return "", false, nil })
	for _, token := range []string{"", "wrong"} {
		if rec := request(s, http.MethodPost, "/save?name=a.gif", token, "GIF89a"); rec.Code != http.StatusForbidden {
			t.Errorf("token %q: status %d, want 403", token, rec.Code)
		}
	}
	if called {
		t.Error("dialog opened without a valid token")
	}
}

func TestSaveRejectsNonGIF(t *testing.T) {
	s := newTestServer(func(string) (string, bool, error) { return "", false, nil })
	if rec := request(s, http.MethodPost, "/save?name=a.gif", "secret", "MZ\x90\x00"); rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want 400", rec.Code)
	}
}

func TestSaveWritesChosenFile(t *testing.T) {
	target := filepath.Join(t.TempDir(), "picked.gif")
	var suggested string
	s := newTestServer(func(name string) (string, bool, error) { suggested = name; return target, true, nil })

	rec := request(s, http.MethodPost, "/save?name="+`..%5C..%5Cdemo%3F.mp4`, "secret", "GIF89a-data")
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	if suggested != "demo.mp4.gif" {
		t.Errorf("suggested name %q", suggested)
	}
	if data, _ := os.ReadFile(target); string(data) != "GIF89a-data" {
		t.Errorf("file content %q", data)
	}
	if s.lastSavedPath() != target {
		t.Errorf("last saved %q", s.lastSavedPath())
	}
}

func TestSaveCancelled(t *testing.T) {
	s := newTestServer(func(string) (string, bool, error) { return "", false, nil })
	rec := request(s, http.MethodPost, "/save?name=a.gif", "secret", "GIF89a")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"cancelled":true`) {
		t.Fatalf("status %d body %s", rec.Code, rec.Body)
	}
}

func TestSafeFileName(t *testing.T) {
	cases := map[string]string{
		"clip.gif":          "clip.gif",
		"화면 녹화.GIF":         "화면 녹화.GIF",
		"C:\\temp\\x.gif":   "x.gif",
		"a<b>:c|d?.gif":     "abcd.gif",
		"":                  "video.gif",
		"...":               "video.gif",
		"report":            "report.gif",
	}
	for in, want := range cases {
		if got := safeFileName(in); got != want {
			t.Errorf("safeFileName(%q) = %q, want %q", in, got, want)
		}
	}
}
