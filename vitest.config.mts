import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * lib 아래 테스트는 전부 상대경로 import라 설정 없이도 돌았지만, 컴포넌트 쪽 코드는
 * `@/lib/...` 별칭을 쓰므로 tsconfig의 paths를 여기에도 알려줘야 한다.
 * (anatomy.test.ts가 poses.ts를 import하면서 처음 필요해졌다)
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
