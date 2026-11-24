# English STT · Even G2

상대방의 영어를 **영어 그대로** G2 화면에 표시하는 개인용 실시간 자막 프로토타입입니다.
G2 마이크 → PCM 전처리 → Soniox 실시간 영어 인식 → G2 + 휴대폰 자막 순서로 동작합니다.
번역하지 않습니다. **인터넷이 필요하며 Soniox API 사용량 요금이 발생합니다.**

## 시작하기 (Windows PowerShell)

Node.js 24 이상이 필요합니다. PowerShell에서 `node -v`로 확인하세요.

```powershell
cd C:\Doc\KTW\1.Project\Vibe_Coding\EvenG2\English_STT
npm.cmd install
if (!(Test-Path .env.local)) {
    Copy-Item .env.example .env.local
}
notepad .env.local
```

[Soniox Console](https://console.soniox.com/)에서 프로젝트 API 키를 생성하고
**Temporary API keys**와 **실시간 Speech-to-Text** 권한을 허용하세요.
기존 Deepgram 키는 사용할 수 없습니다. 기존 `.env.local`이 있다면 변수 이름과 값을 바꾸세요.

```dotenv
SONIOX_API_KEY=your_soniox_api_key
VITE_STT_TOKEN_URL=
```

장기 API 키는 서버에서만 사용합니다. 채팅이나 GitHub에 올리지 말고, VITE_ 변수에 넣지 마세요.
키 변경 시 개발 서버를 재시작하세요. 이 프로젝트의 `.gitignore`는 `.env.local`을 제외합니다.

```powershell
npm.cmd run dev
```

개발 서버를 켜 둔 상태에서 새 터미널을 열어 다음 중 하나로 실행합니다.

```powershell
# 데스크톱 시뮬레이터
npm.cmd run simulate

# 실제 G2: 휴대폰과 PC를 같은 Wi-Fi에 연결하고 PC의 IPv4 주소 사용
npx.cmd evenhub qr --url http://YOUR_PC_IP:5173
```

Even 앱에서 QR로 열고 **시작**을 누르세요. G2 연결과 마이크 권한이 필요합니다.
시뮬레이터의 오디오 입력은 환경에 따라 확인이 필요합니다. 최종 확인은 실제 G2에서 하세요.
일반 브라우저에는 G2 마이크가 연결되지 않으므로 **자막 데모**로 화면만 확인할 수 있습니다.
접속되지 않으면 개발 서버에 표시된 주소, 같은 Wi-Fi, Windows 방화벽의 TCP 5173 포트를 확인하세요.

## 조작과 자막

- 휴대폰 **시작 / 일시정지** 또는 안경 한 번 터치: 인식 시작/중지.
- 안경 두 번 터치: 시스템 종료 확인 창. 취소하면 계속 동작합니다.
- **자막 지우기**: 표시된 최근 자막을 지웁니다. 진행 중인 발화의 후속 결과는 다시 표시될 수 있습니다.
- **저주파 소음 완화**: 100Hz 하이패스 필터를 켜거나 끕니다. 목소리가 약하면 꺼서 비교하세요.
- **자막 데모**: 고정 영어 문장을 표시합니다. Soniox를 호출하지 않아 API 사용량이 발생하지 않습니다.

Soniox의 중간 토큰은 매 응답마다 교체하고, 확정 토큰은 한 번씩 이어 붙입니다.
단어 조각 사이에 임의의 공백을 넣지 않으며 문장부호와 원래 공백을 보존합니다.
제어 토큰 `<end>`·`<fin>`은 자막으로 표시하지 않습니다.
G2에는 최근 약 240자, 휴대폰에는 확정/중간 텍스트 각각 최대 4,000자를 유지합니다.
화면 전송은 180ms 단위로 합치며 BLE 호출을 순차 처리합니다.

## 인식 설정과 연결 안정성

- 실시간 모델: `stt-rt-v6`.
- 음성 형식: PCM signed 16-bit little-endian, 16kHz, mono.
- `language_hints: ["en"]` + `language_hints_strict: true`: 영어에 강하게 제한해,
  강한 억양을 다른 언어로 잘못 판단하는 경우를 줄입니다. 정확도 보장은 아닙니다.
- 기본 semantic endpointing을 사용합니다. 낮은 지연을 위해 발화를 지나치게 빨리 확정하지 않습니다.
- Soniox에 설정을 보낸 뒤 첫 ping/pong을 확인하고 마이크를 켭니다.
- 5초마다 ping을 보내고 10초 동안 응답이 없으면 연결을 중지합니다.
- 전송 대기 음성이 64,000바이트를 넘으면 중지합니다. 연결 전 과거 음성을 쌓아두지 않습니다.
- 인증 요청과 연결 준비에는 각각 12초 제한이 있습니다.
- 일시정지 시 빈 **텍스트** 프레임으로 종료를 알리고, 서버 완료 또는 최대 2초 후 소켓을 닫습니다.
- 백그라운드 전환·종료·연결 오류 시 마이크 중지를 요청합니다.
- 자동 재연결은 하지 않습니다. 오류와 과금되는 연결 재시작을 사용자가 확인하고 시작합니다.
- 한 번의 세션은 단기 키 정책상 최대 1시간입니다. 종료 후 시작을 눌러 다시 연결하세요.

일시정지 시 확정 자막은 유지하고 미확정 발화 및 종료 중 도착한 후속 결과는 버립니다.
사용 중 마이크 스트림을 켜 둔 시간에는 말하지 않는 구간도 비용이 발생할 수 있으므로,
대화가 끝나면 일시정지를 누르세요.

## 소음과 억양의 범위

100Hz 필터는 낮은 진동음과 DC 성분을 줄이는 전처리입니다.
AI 잡음 제거, 주변 사람 말소리 분리, 특정 화자 선택은 구현하지 않았습니다.
작은 목소리나 자음이 사라지지 않도록 강한 음량 게이트나 낮은 신뢰도 단어 삭제는 적용하지 않았습니다.
프랑스·동남아 억양을 위한 별도 모델 학습이나 정확도 보장도 없습니다.

실제 상대방의 영어로 조용한 곳/시끄러운 곳, 필터 켜짐/꺼짐을 비교하세요.
이름·숫자·시간·핵심 단어의 오류와 자막 지연을 확인하는 것이 좋습니다.
Soniox를 사용한다는 사실만으로 기본 Conversate보다 정확하다고 판단할 수는 없습니다.

## 인증·음성 처리·요금

`server/token-middleware.mjs`가 서버의 장기 `SONIOX_API_KEY`로
`POST https://api.soniox.com/v1/auth/temporary-api-key`를 호출합니다.

- 클라이언트에는 `api_key`, `expires_at`만 반환합니다.
- 단기 키는 60초 안에 연결을 시작해야 하며 한 스트림에만 사용할 수 있습니다.
- 키 만료와 별개로 스트림은 최대 3,600초로 제한합니다.
- 브라우저는 `["soniox-api-key", temporaryKey]` WebSocket 프로토콜로 인증합니다.
- 장기 키와 원본 공급자 오류 내용을 클라이언트에 반환하지 않습니다.

음성은 아이폰/클라이언트에서 Soniox WebSocket으로 직접 전송됩니다.
앱은 오디오나 자막을 파일·localStorage에 저장하지 않습니다.
Soniox의 처리·보관 정책과 요금은 별도로 확인하세요.

실시간 STT는 무료·오프라인 기능이 아닙니다. Soniox는 **전체 스트림 시간**에 대한 음성 입력과
텍스트 출력 등의 사용량으로 과금하므로 keepalive나 무음 구간도 무료라고 가정하면 안 됩니다.
계정의 월 비용 제한과 알림은 [Soniox Console](https://console.soniox.com/)에서 설정하세요.
현재 요금은 [공식 요금표](https://soniox.com/pricing)를 확인하세요.

## PC 없이 사용할 배포 구조

**현재 바로 실행 가능한 범위는 개발 서버 + G2/시뮬레이터입니다.**
Soniox로 바꿔도 개발 서버 의존성이 자동으로 없어지지는 않습니다.
토큰 엔드포인트는 Vite 개발 서버 전용이며 `dist`, `npm run preview`, `.ehpk`에 포함되지 않습니다.

아이폰+G2만으로 사용하려면 인터넷에서 접근 가능한 HTTPS 토큰 서버가 필요합니다.

1. 본인 인증·사용량 제한·허용 출처 검사를 갖춘 서버에서 Soniox 단기 키를 발급합니다.
2. `VITE_STT_TOKEN_URL=https://YOUR_BACKEND/api/stt-token`을 설정하고 다시 빌드합니다.
3. 서버는 POST에 `{ "api_key": "snx_temp_...", "expires_at": "UTC timestamp" }` JSON을 반환해야 합니다.
4. `app.json`의 network 권한 `whitelist`에 토큰 서버의 HTTPS 출처를 추가합니다.
5. 장기 키는 서버 환경변수에만 저장합니다.
6. 실제 아이폰+G2에서 인증, PCM 입력, 자막, 일시정지·종료를 검증한 후 배포합니다.

개발용 토큰 서버는 같은 Wi-Fi 시험용입니다. 출처 검사와 분당 20회 제한은 있지만 로그인은 없습니다.
이 서버를 그대로 인터넷에 공개하지 마세요.

## 검증

```powershell
npm.cmd test
npm.cmd run build
# 배포용 토큰 서버를 구성한 이후
npm.cmd run pack
```

테스트는 Soniox 설정·단기 키 인증·첫 pong 전 마이크 차단·토큰 병합·제어 토큰 제외,
PCM 분할 처리·필터 특성·오류·취소·핑 시간 초과·종료·송신 버퍼 한도,
G2 마이크·화면·수명주기 처리를 검사합니다. 외부 API는 모의 응답을 사용합니다.
실제 Soniox 계정·아이폰·G2에서의 정확도와 호환성은 별도 실기 검증이 필요합니다.

## 주요 파일

| 파일 | 역할 |
| --- | --- |
| `src/main.ts` | G2 연결, 마이크·터치·수명주기, 화면 순차 갱신 |
| `src/asr/stt.ts` | Soniox WebSocket 클라이언트와 연결 상태 검사 |
| `src/asr/transcript.ts` | Soniox 확정·중간 토큰 병합과 자막 길이 제한 |
| `src/asr/audio.ts` | PCM16 16kHz mono 저주파 필터 |
| `src/ui.ts`, `src/style.css` | 휴대폰 조작 및 자막 미리보기 |
| `server/token-middleware.mjs` | 개발용 Soniox 단기 API 키 발급 |

프로토콜 참고:
[WebSocket API](https://docs.soniox.com/api-reference/stt/websocket-api),
[단기 키](https://docs.soniox.com/authentication/temporary-api-keys),
[브라우저 인증](https://docs.soniox.com/authentication/websocket-authentication),
[토큰 병합](https://docs.soniox.com/stt/rt/real-time-transcription),
[핑·연결 유지와 과금](https://docs.soniox.com/stt/rt/connection-keepalive),
[영어 제한](https://docs.soniox.com/stt/concepts/language-restrictions).

## 종료 후 무료 요약과 선택형 OpenAI 요약

1. **시작**으로 대화를 인식합니다. **일시정지** 후 다시 시작하면 같은 대화가 이어집니다.
2. **종료·무료 요약**을 누르면 마이크를 중지하고 최대 2초 동안 마지막 확정 결과를 기다립니다.
3. 휴대폰에 무료 요약과 요약에 사용한 대화 원문을 표시합니다. G2에는 요약의 첫 부분을 영어로 표시합니다.
4. 무료 결과가 부족하면 **OpenAI로 다시 요약 (선택·유료)**을 누릅니다.
5. 결과를 보관하려면 **요약 복사 / 대화 복사**를 사용하세요. 새 대화를 시작하면 이전 대화와 요약은 지워집니다.

기본 요약은 휴대폰 안에서 영어 원문의 핵심 문장을 최대 5개 추출합니다.
AI가 내용을 다시 쓰거나 한국어로 번역하는 기능은 아닙니다.
**무료인 것은 이 요약 단계이며 Soniox 음성 인식 요금은 별도입니다.**
OpenAI 버튼을 누르지 않으면 OpenAI로 대화가 전송되거나 API 요청이 발생하지 않습니다.

최근 자막은 4,000자 제한을 유지하지만, 요약용 확정 대화는 메모리에 최대 100,000자를 별도로 보관합니다.
한도를 넘으면 최근 100,000자만 요약하며 화면에 알립니다.
완료 응답을 받지 못했으면 마지막 발화가 누락될 수 있다는 안내를 표시합니다.
미확정 음성은 사실로 간주해 요약에 넣지 않습니다.

**앱 종료와 대화 종료는 다릅니다.** 안경 더블 탭의 시스템 종료는 플러그인 자체를 닫습니다.
요약을 보려면 먼저 휴대폰의 종료·무료 요약을 사용하세요.
대화와 요약은 파일이나 기기 저장소에 자동 저장하지 않으며, 새로고침·앱 종료 시 사라집니다.

### OpenAI는 선택 사항

무료 요약에는 키 설정이 필요 없습니다. 자연스러운 한국어 요약, 결정사항, 할 일을 추가하려면
서버의 .env.local에 다음을 설정한 뒤 개발 서버를 재시작하세요.

~~~dotenv
OPENAI_API_KEY=your_openai_api_key
OPENAI_SUMMARY_MODEL=gpt-6.1-terra
VITE_SUMMARY_URL=
~~~

OpenAI 모델은 서버의 OPENAI_SUMMARY_MODEL로 변경할 수 있습니다.
기본값은 Responses API와 Structured Outputs를 지원하는 gpt-6.1-terra입니다.
서버는 출력 길이를 제한하고 store:false로 요청하며 대화 내용을 로그에 기록하지 않습니다.
OpenAI의 서비스 측 데이터 처리 정책은 별도로 확인하세요.

OpenAI 버튼을 누를 때 대화 텍스트가 요약 서버를 거쳐 OpenAI로 전송됩니다.
별도 API 사용량 요금이 발생하며 ChatGPT 구독과 API 과금은 구분됩니다.
키가 없거나 요청이 실패해도 기존 무료 요약을 유지합니다.
동일 서버에서는 한 번에 한 요청, 분당 최대 5회로 제한하며 자동 재시도하지 않습니다.
새 대화를 시작하거나 지우면 진행 중 요약 요청을 취소하고 이전 응답을 무시합니다.
요청 취소 전에 이미 처리된 사용량은 과금될 수 있습니다.

배포 시에는 인증과 사용량 제한을 갖춘 HTTPS POST 요약 서버가 추가로 필요합니다.
VITE_SUMMARY_URL을 해당 주소로 설정하고 app.json의 network whitelist에 그 출처를 추가하세요.
요청은 { "transcript": "확정 대화 텍스트" }, 응답은
{ "summary": { "overview": "...", "highlights": [], "decisions": [], "actions": [], "lensText": "English lens summary" } }
형식입니다. VITE_ 변수나 G2 패키지에 장기 OPENAI_API_KEY를 넣으면 안 됩니다.
개발용 /api/summary를 로그인 없이 인터넷에 공개하지 마세요.

주요 추가 파일: src/asr/conversation.ts, src/summary/summary.ts, src/summary/client.ts,
server/summary-middleware.mjs.

참고: [OpenAI 텍스트 생성](https://developers.openai.com/api/docs/guides/text),
[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs),
[GPT-6.1 Terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra).
