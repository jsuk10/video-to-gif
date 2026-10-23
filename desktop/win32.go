package main

import (
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"syscall"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	comdlg32                 = windows.NewLazySystemDLL("comdlg32.dll")
	procGetSaveFileNameW     = comdlg32.NewProc("GetSaveFileNameW")
	procCommDlgExtendedError = comdlg32.NewProc("CommDlgExtendedError")

	user32               = windows.NewLazySystemDLL("user32.dll")
	procMessageBoxW      = user32.NewProc("MessageBoxW")
	procGetSystemMetrics = user32.NewProc("GetSystemMetrics")
	procGetDpiForSystem  = user32.NewProc("GetDpiForSystem")
)

// OPENFILENAMEW 와 같은 배치.
type openFileName struct {
	structSize    uint32
	owner         uintptr
	instance      uintptr
	filter        *uint16
	customFilter  *uint16
	maxCustFilter uint32
	filterIndex   uint32
	file          *uint16
	maxFile       uint32
	fileTitle     *uint16
	maxFileTitle  uint32
	initialDir    *uint16
	title         *uint16
	flags         uint32
	fileOffset    uint16
	fileExtension uint16
	defExt        *uint16
	custData      uintptr
	hook          uintptr
	templateName  *uint16
	reserved      uintptr
	reserved2     uint32
	flagsEx       uint32
}

const (
	ofnOverwritePrompt = 0x00000002
	ofnNoChangeDir     = 0x00000008
	ofnPathMustExist   = 0x00000800
	ofnExplorer        = 0x00080000
)

// 표준 '다른 이름으로 저장' 창. 사용자가 취소하면 ok 가 false 다.
func saveFileDialog(owner uintptr, suggested string) (path string, ok bool, err error) {
	file := make([]uint16, windows.MAX_LONG_PATH)
	copy(file[:len(file)-1], utf16.Encode([]rune(suggested)))
	// 필터 문자열은 NUL 로 구분하고 NUL 두 개로 끝난다.
	filter := utf16.Encode([]rune("GIF 이미지 (*.gif)\x00*.gif\x00\x00"))

	dialog := openFileName{
		owner:   owner,
		filter:  &filter[0],
		file:    &file[0],
		maxFile: uint32(len(file)),
		title:   windows.StringToUTF16Ptr("GIF 저장"),
		defExt:  windows.StringToUTF16Ptr("gif"),
		flags:   ofnOverwritePrompt | ofnNoChangeDir | ofnPathMustExist | ofnExplorer,
	}
	dialog.structSize = uint32(unsafe.Sizeof(dialog))

	r, _, _ := procGetSaveFileNameW.Call(uintptr(unsafe.Pointer(&dialog)))
	if r == 0 {
		code, _, _ := procCommDlgExtendedError.Call()
		if code == 0 {
			return "", false, nil
		}
		return "", false, fmt.Errorf("저장 창을 열지 못했어요. (코드 %#x)", code)
	}
	return windows.UTF16ToString(file), true, nil
}

func messageBox(title, text string) {
	const mbOK, mbIconInformation = 0x0, 0x40
	_, _, _ = procMessageBoxW.Call(0,
		uintptr(unsafe.Pointer(windows.StringToUTF16Ptr(text))),
		uintptr(unsafe.Pointer(windows.StringToUTF16Ptr(title))),
		mbOK|mbIconInformation)
}

// 기본 브라우저로 연다. 웹 주소만 받는다.
func openURL(url string) error {
	if !strings.HasPrefix(url, "https://") && !strings.HasPrefix(url, "http://127.0.0.1:") {
		return errors.New("열 수 없는 주소예요.")
	}
	return windows.ShellExecute(0, windows.StringToUTF16Ptr("open"), windows.StringToUTF16Ptr(url), nil, nil, windows.SW_SHOWNORMAL)
}

// 탐색기를 열고 파일을 선택해 둔다.
func revealFile(path string) error {
	cmd := exec.Command("explorer.exe")
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: fmt.Sprintf(`explorer.exe /select,"%s"`, path)}
	return cmd.Start()
}

// 처음 창 크기. 화면 배율(DPI)을 반영하고, 작은 화면에서는 화면 안에 들어오게 줄인다.
func initialWindowSize(logicalWidth, logicalHeight uint) (width, height uint) {
	dpi := uint(96)
	if procGetDpiForSystem.Find() == nil {
		if r, _, _ := procGetDpiForSystem.Call(); r != 0 {
			dpi = uint(r)
		}
	}
	const smCxScreen, smCyScreen = 0, 1
	screenWidth, _, _ := procGetSystemMetrics.Call(smCxScreen)
	screenHeight, _, _ := procGetSystemMetrics.Call(smCyScreen)
	width = min(logicalWidth*dpi/96, uint(screenWidth)*92/100)
	height = min(logicalHeight*dpi/96, uint(screenHeight)*88/100)
	return width, height
}

func scaleForDPI(value int) int {
	if procGetDpiForSystem.Find() == nil {
		if r, _, _ := procGetDpiForSystem.Call(); r != 0 {
			return value * int(r) / 96
		}
	}
	return value
}
