# English STT · Even G2

상대방의 영어를 **영어 그대로** G2 화면에 표시하는 개인용 실시간 자막 프로토타입입니다.
G2 마이크 → PCM 전처리 → Deepgram Nova-3 영어 스트리밍 인식 → G2 + 휴대폰 자막 순서로 동작합니다.
번역하거나 억양을 별도로 변환하지 않습니다.

## 시작하기 (Windows PowerShell)

Node.js 24 이상이 필요합니다. 테스트는 Node.js 24에서 확인했습니다.

```powershell
cd C:\Doc\KTW\1.Project\Vibe_Coding\EvenG2\English_STT
npm install
Copy-Item .env.example .env.local
```

`.env.local`에 본인의 Deepgram API 키를 입력하세요. 채팅이나 GitHub에 키를 올리지 마세요.

```dotenv
DEEPGRAM_API_KEY=your_deepgram_api_key
VITE_STT_TOKEN_URL=
```

토큰 발급용 API 키에는 Deepgram **Member 이상의 권한**이 필요합니다. API 사용에는 계정의 크레딧/요금이 적용됩니다.
`VITE_STT_API_KEY`는 사용하지 않습니다. 장기 API 키는 VITE_ 변수에 넣지 마세요.
설정 후 서버를 시작하며, 키 변경 시 서버를 재시작하세요.

```powershell
npm run dev
```

개발 서버를 켜 둔 상태에서 새 터미널을 열어 다음 중 하나로 실행합니다.

```powershell
# 데스크톱 시뮬레이터 (기본 개발 서버 주소 localhost:5173)
npm run simulate

# 실제 G2: 휴대폰과 PC를 같은 Wi-Fi에 연결하고 PC의 IPv4 주소 사용
npx evenhub qr --url http://YOUR_PC_IP:5173
```

Even 앱에서 QR로 열고 **시작** 버튼을 누르세요. G2와 Even 앱의 마이크 권한이 필요합니다.
시뮬레이터의 마이크 입력 지원은 환경에 따라 다릅니다. 실제 PCM 입력은 G2에서 최종 확인하세요.
일반 브라우저에서는 G2 마이크가 연결되지 않습니다. **자막 데모**로 화면만 확인할 수 있습니다.
방화벽으로 연결되지 않으면 개발 서버의 5173 포트와 같은 Wi-Fi 연결을 확인하세요.

## 조작과 자막

- 휴대폰 **시작 / 일시정지** 또는 안경 한 번 터치: 음성 인식 시작/중지.
- 안경 두 번 터치: 시스템 종료 확인 창. 취소 시 계속 동작합니다.
- **자막 지우기**: 메모리의 최근 자막을 지웁니다. 현재 발화의 후속 결과는 다시 표시될 수 있습니다.
- **저주파 소음 완화**: 100 Hz 하이패스 필터를 켜거나 끕니다. 목소리가 약하면 꺼서 비교하세요.
- **자막 데모**: 고정된 영어 문장을 표시합니다. 실제 인식·억양 품질을 시험하는 기능은 아닙니다.

중간 인식 결과는 수정되며 확정 결과만 이어 붙입니다. G2에는 최근 약 240자,
휴대폰에는 최근 4,000자를 유지합니다. G2 화면 전송은 180ms 단위로 합치며 BLE 호출을 순차 처리합니다.
재시작 시 확정 자막을 유지하지만 일시정지 직전의 미확정 발화는 버립니다.
백그라운드 진입·종료·인식 연결 오류 시 마이크 중지를 요청합니다. 재개하려면 시작을 다시 누르세요.
느린 네트워크에서 과거 음성이 계속 쌓이면 연결을 중지하고 오류를 알립니다.

## 소음과 억양의 범위

이 버전의 필터는 바람/진동/기계음의 **낮은 주파수 성분과 DC 성분**을 줄입니다.
팬의 모든 소리, 음악, 옆 사람 말소리까지 제거하는 AI 소음 제거는 아닙니다.
조용한 단어가 잘리지 않도록 하드 노이즈 게이트와 낮은 신뢰도 단어 삭제는 적용하지 않았습니다.
G2 착용자의 목소리와 상대방 목소리가 모두 인식될 수 있으며, 특정 화자 선택은 구현하지 않았습니다.

Nova-3의 영어 모델을 사용하지만 프랑스/동남아 억양에 맞춘 별도 학습이나 정확도 보장은 없습니다.
실제 대화 상대의 음성으로 조용한 곳/카페, 필터 켜짐/꺼짐을 비교하세요.
먼저 사람 이름·숫자·시간·핵심 명사의 누락과 자막 지연을 확인하는 것이 좋습니다.
상대방과 가까운 거리에서, 겹쳐 말하지 않는 조건이 유리합니다.

## 키·음성 처리와 배포 범위

`server/token-middleware.mjs`가 장기 키로 `/v1/auth/grant`를 호출하고,
WebView에는 단기 토큰만 전달합니다. 음성은 WebSocket으로 Deepgram에 전송합니다.
앱은 오디오/자막을 파일이나 localStorage에 저장하지 않습니다. Deepgram의 보관 정책은 별도로 확인하세요.
모델 개선 사용 제외 요청 `mip_opt_out=true`를 전송합니다.

**현재 바로 실행 가능한 범위는 개발 서버 + G2/시뮬레이터입니다.** 토큰 엔드포인트는
Vite 개발 서버 전용이며, `dist`, `npm run preview`, `.ehpk`에는 포함되지 않습니다.
개발 서버는 같은 Wi-Fi 시험용입니다. 토큰 엔드포인트에 출처 확인과 분당 20회 제한이 있지만,
사용자 로그인은 없으므로 인터넷에 그대로 공개하지 마세요.

실제 배포 시에는 로그인/사용량 제한/CORS를 갖춘 HTTPS 토큰 서버를 준비하고 다음을 설정해야 합니다.

1. `VITE_STT_TOKEN_URL=https://YOUR_BACKEND/api/stt-token`으로 설정 후 다시 빌드.
2. 해당 서버는 `POST` 요청에 `{ "access_token": "temporary JWT", "expires_in": 30 }` JSON을 반환.
3. `app.json`의 `network.whitelist`에 해당 HTTPS 서버의 출처를 추가.
4. 장기 `DEEPGRAM_API_KEY`는 해당 서버의 환경 변수로만 관리.
5. 실제 G2에서 토큰 서버 접근, 자막, 마이크 중지 및 종료를 검증한 후 패키지 배포.

현재 `app.json`에는 Deepgram HTTP/WebSocket 호스트 및 G2 마이크 권한을 선언했습니다.

## 검증

```powershell
npm test
npm run build
# 배포용 토큰 서버를 구성한 이후
npm run pack
```

테스트는 중간/확정 자막 병합·중복 방지·길이 제한, 분할 PCM 샘플 처리,
필터의 저주파 감쇠/음성 대역 유지, 토큰 발급 오류·출처·요청 제한,
WebSocket 인증/종료/취소/송신 버퍼 한도를 검사합니다. 외부 API는 모의 응답을 사용합니다.
API 키와 실제 G2가 없는 환경에서는 실제 음성 인식 품질과 G2 화면 가독성을 검증할 수 없습니다.

## 주요 파일

| 파일 | 역할 |
| --- | --- |
| `src/main.ts` | G2 연결, 마이크/터치/수명주기, 화면 순차 갱신 |
| `src/asr/stt.ts` | Deepgram 영어 스트리밍 클라이언트 |
| `src/asr/transcript.ts` | 확정/중간 자막과 최근 텍스트 관리 |
| `src/asr/audio.ts` | PCM16 16kHz mono 저주파 필터 |
| `src/ui.ts`, `src/style.css` | 휴대폰 조작 및 자막 미리보기 |
| `server/token-middleware.mjs` | 개발용 단기 토큰 발급 |

프로토콜 참고: [Deepgram 스트리밍](https://developers.deepgram.com/reference/speech-to-text/listen-streaming),
[단기 토큰 인증](https://developers.deepgram.com/guides/fundamentals/token-based-authentication),
[중간/확정 결과와 endpointing](https://developers.deepgram.com/docs/understand-endpointing-interim-results).
