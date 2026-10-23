# 동영상을 GIF로

동영상을 GIF로 바꾸는 웹 도구입니다. 변환은 브라우저 안에서만 일어나고, 파일은 어디에도 업로드되지 않습니다.

**바로 쓰기: https://jsuk10.github.io/video-to-gif/**

## 할 수 있는 것

- MP4, WebM, MOV 파일을 끌어다 놓거나, 골라서 열거나, Ctrl+V로 붙여 넣기
- 구간 자르기 (손잡이를 끌거나, "지금 위치를 시작으로/끝으로" 버튼)
- 가로 크기, 초당 프레임, 재생 속도(0.5×~2×), 색 수, 무한 반복 여부 고르기
- 영상 종류에 맞는 인코딩
  - **화면 녹화**: 모든 프레임이 팔레트 하나를 같이 쓰고, 앞 프레임과 같은 픽셀은 비워서 바뀐 곳만 저장합니다. UI 데모처럼 화면 대부분이 가만히 있는 영상이면 파일이 많이 작아집니다.
  - **실사 영상**: 프레임마다 팔레트를 새로 만들어서 색이 정확합니다. 대신 파일이 큽니다.
- 결과가 GitHub 이슈, PR 첨부 한도(10MB)를 넘는지 바로 알려 줌

## 데스크톱판 (Windows exe)

인터넷이 막혀 있거나 외부 사이트를 쓸 수 없는 환경을 위한 실행 파일입니다. 설치 없이 실행합니다.

**받기: [video-to-gif.exe 바로 받기](https://github.com/jsuk10/video-to-gif/releases/latest/download/video-to-gif.exe)** (웹판 오른쪽 위 "Windows용 exe 받기" 버튼과 같은 파일, 버전별 기록은 [Releases](https://github.com/jsuk10/video-to-gif/releases))

- 웹판과 같은 화면을 프로그램 창에 띄웁니다. 화면 파일과 글꼴은 모두 exe 안에 들어 있고, 이 PC 안(`127.0.0.1`)에서만 열리는 서버로 창에 넘깁니다.
- 외부로 나가는 연결은 콘텐츠 보안 정책(CSP)으로 막혀 있습니다. 스크립트, 글꼴, 이미지 모두 exe 안에서만 옵니다.
- GIF는 Windows의 "다른 이름으로 저장" 창으로 저장합니다.
- Windows 10/11에 들어 있는 WebView2 런타임으로 창을 그립니다. WebView2가 없는 PC에서는 기본 브라우저로 같은 화면을 엽니다. 이때도 변환은 PC 안에서만 일어납니다.
- 마지막 설정과 WebView2 캐시는 `%LOCALAPPDATA%\VideoToGif`에 둡니다. 이 폴더를 지우면 흔적이 남지 않습니다.
- 코드 서명이 없어서 처음 실행할 때 "Windows의 PC 보호" 창이 뜰 수 있습니다. "추가 정보 → 실행"을 누르면 됩니다. 서명 안 된 exe를 막는 회사 PC라면 IT 담당자에게 허용을 요청해야 합니다.
- 받은 파일이 Releases에 적힌 것과 같은지 확인하려면 PowerShell에서 `Get-FileHash video-to-gif.exe`를 실행해 SHA-256 값을 비교하세요.

### 직접 빌드

Go와 [go-winres](https://github.com/tc-hib/go-winres)가 필요합니다.

```powershell
go install github.com/tc-hib/go-winres@latest
cd desktop
.\build.ps1
```

`desktop\dist\video-to-gif.exe`가 만들어집니다. 빌드 스크립트는 웹판 파일을 `desktop\web`으로 복사하면서 CDN 글꼴을 exe에 넣는 글꼴로 바꾸고, 테스트를 돌린 뒤 빌드합니다.

## GitHub README에 넣기

만든 GIF를 저장소에 커밋하고 README에서 상대 경로로 부르면 됩니다.

```markdown
![데모](docs/demo.gif)
```

이슈나 PR 본문이라면 GIF 파일을 입력창에 끌어다 놓기만 해도 됩니다(10MB 이하).

## 로컬에서 실행

빌드 단계가 없는 정적 파일입니다. 다만 Web Worker를 모듈로 불러오기 때문에 `file://`로 열면 동작하지 않고, 아무 정적 서버로 띄워야 합니다.

```bash
npx serve .
```

## 동작 방식

1. 숨겨 둔 `<video>`를 프레임 시각마다 탐색(seek)하고, 캔버스에 그려 픽셀을 읽습니다.
2. 픽셀을 Web Worker로 넘겨 [gifenc](https://github.com/mattdesl/gifenc)로 팔레트를 만들고 GIF 프레임을 씁니다. 화면이 멈추지 않도록 인코딩은 워커에서 하고, 워커가 밀리면 프레임 추출을 잠시 멈춥니다.
3. GIF 지연 시간은 1/100초 단위라서, 누적 시각을 반올림해 프레임마다 나눠 전체 길이가 밀리지 않게 합니다.

## 한계

- 브라우저가 재생할 수 있는 코덱만 열립니다. AVI나 일부 HEVC(H.265) 영상은 MP4(H.264)나 WebM으로 바꿔서 넣어 주세요.
- 키프레임 간격이 아주 긴 고해상도 영상은 탐색이 느려서 변환이 오래 걸릴 수 있습니다.
- GIF는 최대 256색이라 그라디언트에 띠가 생길 수 있습니다. 실사 영상이면 "실사 영상" 모드가 낫습니다.

## 라이선스

- GIF 인코더 [gifenc](https://github.com/mattdesl/gifenc): MIT 라이선스. `vendor/`에 원문 라이선스와 함께 들어 있습니다.
- 데스크톱판 글꼴 [Pretendard](https://github.com/orioncactus/pretendard): SIL Open Font License 1.1. `desktop/assets/fonts/`에 원문 라이선스와 함께 들어 있습니다.
- 데스크톱판 WebView2 연결 [go-webview2](https://github.com/jchv/go-webview2): MIT 라이선스.
