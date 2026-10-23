// 동영상을 GIF로 데스크톱판.
// 웹판과 같은 화면을 WebView2 창에 띄운다. 화면 파일은 실행 파일 안에 들어 있고,
// 이 PC 안(127.0.0.1)에서만 열리는 서버로 창에 넘긴다. 인터넷 연결은 쓰지 않는다.
package main

import (
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"

	webview2 "github.com/jchv/go-webview2"
)

const appTitle = "동영상을 GIF로"

// 포트를 고정해야 다시 열어도 주소(origin)가 같아서 마지막 설정이 남는다. 이미 쓰이고 있으면 빈 포트를 쓴다.
const preferredAddr = "127.0.0.1:47321"

//go:embed all:web
var embedded embed.FS

func main() {
	files, err := fs.Sub(embedded, "web")
	if err != nil {
		fail(err)
	}
	listener, err := net.Listen("tcp", preferredAddr)
	if err != nil {
		listener, err = net.Listen("tcp", "127.0.0.1:0")
	}
	if err != nil {
		fail(err)
	}
	addr := listener.Addr().String()
	srv := &server{addr: addr, token: newToken(), files: files}
	url := "http://" + addr + "/"

	width, height := initialWindowSize(1180, 860)
	view := webview2.NewWithOptions(webview2.WebViewOptions{
		AutoFocus: true,
		DataPath:  filepath.Join(os.Getenv("LOCALAPPDATA"), "VideoToGif", "WebView2"),
		WindowOptions: webview2.WindowOptions{
			Title:  appTitle,
			Width:  width,
			Height: height,
			IconId: 1,
			Center: true,
		},
	})

	// WebView2 런타임이 없는 PC(오래된 Windows 10 일부)에서는 기본 브라우저로 같은 화면을 연다.
	if view == nil {
		go http.Serve(listener, srv.handler())
		if err := openURL(url); err != nil {
			fail(err)
		}
		messageBox(appTitle, "이 PC에 WebView2 런타임이 없어서 기본 브라우저로 열었어요.\n"+
			"변환은 여전히 이 PC 안에서만 일어나요.\n\n다 쓰셨으면 확인을 눌러 프로그램을 끝내 주세요.")
		return
	}
	defer view.Destroy()

	owner := uintptr(view.Window())
	// 저장 창은 창을 만든 스레드에서 띄워야 모달로 제대로 붙는다.
	srv.saveDialog = func(suggested string) (string, bool, error) {
		type result struct {
			path string
			ok   bool
			err  error
		}
		done := make(chan result, 1)
		view.Dispatch(func() {
			path, ok, err := saveFileDialog(owner, suggested)
			done <- result{path, ok, err}
		})
		r := <-done
		return r.path, r.ok, r.err
	}
	go http.Serve(listener, srv.handler())

	view.SetSize(scaleForDPI(720), scaleForDPI(560), webview2.HintMin)
	desktop, _ := json.Marshal(map[string]string{"token": srv.token})
	view.Init(fmt.Sprintf("window.__DESKTOP__ = %s;", desktop))
	_ = view.Bind("openExternal", openURL)
	_ = view.Bind("revealSaved", func() error {
		if path := srv.lastSavedPath(); path != "" {
			return revealFile(path)
		}
		return nil
	})
	view.Navigate(url)
	view.Run()
}

func newToken() string {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		fail(err)
	}
	return hex.EncodeToString(buf)
}

func fail(err error) {
	messageBox(appTitle, "프로그램을 시작하지 못했어요.\n\n"+err.Error())
	os.Exit(1)
}
