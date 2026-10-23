// 웹판 파일을 desktop/web 으로 복사하고, 데스크톱판에 맞게 다듬는다.
// desktop 폴더에서 `go run ./tools/prepare` 로 실행한다 (build.ps1 이 부른다).
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	repoRoot = ".."
	outDir   = "web"
)

var copies = map[string]string{
	"app.js":                   "app.js",
	"encoder-worker.js":        "encoder-worker.js",
	"style.css":                "style.css",
	"favicon.svg":              "favicon.svg",
	"vendor/gifenc.esm.js":     "vendor/gifenc.esm.js",
	"vendor/gifenc.LICENSE.md": "vendor/gifenc.LICENSE.md",
	"desktop/assets/fonts/PretendardVariable.woff2": "fonts/PretendardVariable.woff2",
	"desktop/assets/fonts/Pretendard-LICENSE.txt":   "fonts/Pretendard-LICENSE.txt",
}

// 웹판 index.html 에서 바꿀 곳. 원문이 바뀌어 찾지 못하면 빌드를 멈춘다.
var htmlEdits = []struct{ from, to string }{
	{
		`<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">`,
		`<link rel="stylesheet" href="fonts/pretendard.css">`,
	},
	{
		`파일은 서버로 올라가지 않아요. 이 브라우저 안에서만 변환돼요.`,
		`인터넷 연결 없이 이 PC 안에서만 변환돼요.`,
	},
}

// 웹판에만 있는 구간(데스크톱판 받기 버튼 등). <!-- web-only ... --> 부터 <!-- /web-only --> 까지 지운다.
var webOnly = regexp.MustCompile(`(?s)[ \t]*<!-- web-only.*?<!-- /web-only -->\n?`)

const fontCSS = `@font-face {
  font-family: "Pretendard Variable";
  font-weight: 45 920;
  font-style: normal;
  font-display: swap;
  src: url("PretendardVariable.woff2") format("woff2");
}
`

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "prepare:", err)
		os.Exit(1)
	}
}

func run() error {
	if err := os.RemoveAll(outDir); err != nil {
		return err
	}
	for from, to := range copies {
		data, err := os.ReadFile(filepath.Join(repoRoot, from))
		if err != nil {
			return err
		}
		if err := write(to, data); err != nil {
			return err
		}
	}

	html, err := os.ReadFile(filepath.Join(repoRoot, "index.html"))
	if err != nil {
		return err
	}
	// Windows 에서 받은 저장소는 줄바꿈이 CRLF 일 수 있다. 여러 줄 패턴이 어긋나지 않게 맞춘다.
	text := strings.ReplaceAll(string(html), "\r\n", "\n")
	if !webOnly.MatchString(text) {
		return fmt.Errorf("index.html 에서 web-only 구간을 찾지 못했어요")
	}
	text = webOnly.ReplaceAllString(text, "")
	for _, edit := range htmlEdits {
		if !strings.Contains(text, edit.from) {
			return fmt.Errorf("index.html 에서 %q 를 찾지 못했어요", edit.from)
		}
		text = strings.Replace(text, edit.from, edit.to, 1)
	}
	if strings.Contains(text, "https://cdn.") {
		return fmt.Errorf("index.html 에 아직 외부 CDN 주소가 남아 있어요")
	}
	if err := write("index.html", []byte(text)); err != nil {
		return err
	}
	return write("fonts/pretendard.css", []byte(fontCSS))
}

func write(name string, data []byte) error {
	target := filepath.Join(outDir, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	return os.WriteFile(target, data, 0o644)
}
