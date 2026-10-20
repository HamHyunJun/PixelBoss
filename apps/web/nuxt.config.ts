// VoxelHQ 프론트엔드 설정
// Three.js / xterm.js 는 브라우저 전용이라 SPA 모드(ssr: false)로 동작한다.
export default defineNuxtConfig({
  compatibilityDate: '2026-10-01',
  ssr: false,
  devtools: { enabled: false },
  css: ['@xterm/xterm/css/xterm.css', '~/assets/styles/main.scss'],
  app: {
    head: {
      title: 'VoxelHQ · AI Virtual Company',
      htmlAttrs: { lang: 'ko' },
      meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }],
      link: [
        { rel: 'stylesheet', href: 'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable.min.css' },
      ],
    },
  },
  runtimeConfig: {
    public: {
      // 비워두면 현재 호스트의 4100 포트로 접속
      wsUrl: '',
    },
  },
  typescript: { strict: true },
  vite: {
    optimizeDeps: { include: ['three', 'three/examples/jsm/controls/OrbitControls.js', '@xterm/xterm', '@xterm/addon-fit'] },
  },
})
