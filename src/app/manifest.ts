import type { MetadataRoute } from 'next';

/**
 * PWA manifest.
 *
 * 이 파일이 있으면 Next가 `<link rel="manifest">`를 자동으로 넣어 주므로
 * layout.tsx의 metadata에는 manifest를 따로 적지 않는다 — 두 군데에 두면 값이 갈라진다.
 *
 * 서비스워커는 넣지 않는다. 오프라인 프리캐시는 낡은 JS 번들을 살려 두는 장치인데,
 * 그 번들에는 스키마 마이그레이션이 없다 — 캐시된 구버전 코드가 최신 저장 데이터를
 * 읽는 것이 이 앱에서 가장 위험한 실패 모드다. 게다가 오프라인이어도 로그인과 온라인
 * 대전이 안 되므로 실이득도 작다. manifest만으로 iOS "홈 화면에 추가"와 데스크톱
 * Chrome 메뉴 설치는 그대로 동작한다.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    // start_url이 바뀌어도 설치된 앱의 정체성이 유지되도록 따로 둔다.
    id: '/',
    name: 'Anyway Baseball — 선택으로 완성하는 야구',
    // 홈 화면 라벨. iOS는 12자 남짓에서 자른다.
    short_name: 'Anyway BB',
    description:
      '구종, 스윙, 선수 교체까지 직접 결정하세요. 팀을 만들고 성장시키며 시즌을 완성하는 브라우저 3D 야구.',
    lang: 'ko',
    dir: 'ltr',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    // 가로·세로를 잠그는 코드가 앱 어디에도 없다. manifest에서만 잠그면 화면이 어긋난다.
    orientation: 'any',
    background_color: '#030806',
    // layout.tsx의 viewport.themeColor와 같은 값이어야 상태바와 스플래시가 어긋나지 않는다.
    theme_color: '#06100c',
    categories: ['games', 'sports'],
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      // maskable은 별도 파일이다. 같은 파일을 쓰면 안드로이드가 가장자리를 깎아 공이 잘린다.
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
