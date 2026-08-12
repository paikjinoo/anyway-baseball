import type { Metadata, Viewport } from 'next';
import './globals.css';
import { AppShell } from '@/components/AppShell';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'),
  title: {
    default: 'Anyway Baseball — 선택으로 완성하는 야구',
    template: '%s · Anyway Baseball',
  },
  description:
    '구종, 스윙, 선수 교체까지 직접 결정하세요. 팀을 만들고 성장시키며 시즌을 완성하는 브라우저 3D 야구.',
  openGraph: {
    title: 'Anyway Baseball — 선택으로 완성하는 야구',
    description: '구종 하나, 스윙 한 번, 선수 교체의 타이밍까지. PLAY THE WHOLE GAME.',
    siteName: 'Anyway Baseball',
    locale: 'ko_KR',
    type: 'website',
    images: [
      {
        url: '/og.png',
        width: 1672,
        height: 941,
        alt: '조명 아래 야간 구장에서 펼쳐지는 Anyway Baseball',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Anyway Baseball — 선택으로 완성하는 야구',
    description: 'PLAY THE WHOLE GAME. 브라우저에서 즐기는 3D 야구 시뮬레이션.',
    images: ['/og.png'],
  },
  // manifest는 여기 적지 않는다 — app/manifest.ts가 있으면 Next가 자동으로 넣는다.
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    // iOS는 PNG만 인식하고 투명 픽셀을 검게 칠한다. 배경을 미리 깐 파일을 쓴다.
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  appleWebApp: {
    capable: true,
    title: 'Anyway Baseball',
    // black-translucent는 상태바가 헤더 위로 겹쳐 레이아웃을 다시 짜야 한다.
    statusBarStyle: 'black',
  },
};

export const viewport: Viewport = {
  colorScheme: 'dark',
  themeColor: '#06100c',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
