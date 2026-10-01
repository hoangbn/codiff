import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    copy: [
      { from: 'fonts', to: 'dist' },
      { from: 'App.css.d.ts', rename: 'styles.css.d.ts', to: 'dist' },
    ],
    deps: {
      resolveDepSubpath: true,
    },
    dts: false,
    loader: {
      '.svg': 'dataurl',
    },
  },
});
