// vitest.config.mts
import { puyaTsTransformer } from 'file:///home/bit/code/xgov-delegator/node_modules/.pnpm/@algorandfoundation+algorand-typescript-testing@1.1.0_tslib@2.8.1/node_modules/@algorandfoundation/algorand-typescript-testing/test-transformer/vitest-transformer.mjs'
import typescript from 'file:///home/bit/code/xgov-delegator/node_modules/.pnpm/@rollup+plugin-typescript@12.3.0_rollup@4.56.0_tslib@2.8.1_typescript@5.9.3/node_modules/@rollup/plugin-typescript/dist/es/index.js'
import { defineConfig } from 'file:///home/bit/code/xgov-delegator/node_modules/.pnpm/vitest@2.1.9_@types+node@25.2.1/node_modules/vitest/dist/config.js'
var vitest_config_default = defineConfig({
  esbuild: {},
  test: {
    testTimeout: 3e4,
    coverage: {
      provider: 'v8',
    },
  },
  plugins: [
    typescript({
      tsconfig: './tsconfig.test.json',
      transformers: {
        before: [puyaTsTransformer],
      },
    }),
  ],
})
export { vitest_config_default as default }
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZXN0LmNvbmZpZy5tdHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvaG9tZS9iaXQvY29kZS94Z292LWRlbGVnYXRvci9wcm9qZWN0cy9jb250cmFjdHNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi9ob21lL2JpdC9jb2RlL3hnb3YtZGVsZWdhdG9yL3Byb2plY3RzL2NvbnRyYWN0cy92aXRlc3QuY29uZmlnLm10c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vaG9tZS9iaXQvY29kZS94Z292LWRlbGVnYXRvci9wcm9qZWN0cy9jb250cmFjdHMvdml0ZXN0LmNvbmZpZy5tdHNcIjtpbXBvcnQgeyBwdXlhVHNUcmFuc2Zvcm1lciB9IGZyb20gJ0BhbGdvcmFuZGZvdW5kYXRpb24vYWxnb3JhbmQtdHlwZXNjcmlwdC10ZXN0aW5nL3ZpdGVzdC10cmFuc2Zvcm1lcidcbmltcG9ydCB0eXBlc2NyaXB0IGZyb20gJ0Byb2xsdXAvcGx1Z2luLXR5cGVzY3JpcHQnXG5pbXBvcnQgeyBkZWZpbmVDb25maWcgfSBmcm9tICd2aXRlc3QvY29uZmlnJ1xuXG5leHBvcnQgZGVmYXVsdCBkZWZpbmVDb25maWcoe1xuICBlc2J1aWxkOiB7fSxcbiAgdGVzdDogeyAgICBcbiAgICB0ZXN0VGltZW91dDogMzAwMDAsXG4gICAgY292ZXJhZ2U6IHtcbiAgICAgIHByb3ZpZGVyOiAndjgnLFxuICAgIH0sXG4gIH0sXG4gIHBsdWdpbnM6IFtcbiAgICB0eXBlc2NyaXB0KHtcbiAgICAgIHRzY29uZmlnOiAnLi90c2NvbmZpZy50ZXN0Lmpzb24nLFxuICAgICAgdHJhbnNmb3JtZXJzOiB7XG4gICAgICAgIGJlZm9yZTogW3B1eWFUc1RyYW5zZm9ybWVyXSxcbiAgICAgIH0sXG4gICAgfSksXG4gIF0sXG59KVxuIl0sCiAgIm1hcHBpbmdzIjogIjtBQUF3VSxTQUFTLHlCQUF5QjtBQUMxVyxPQUFPLGdCQUFnQjtBQUN2QixTQUFTLG9CQUFvQjtBQUU3QixJQUFPLHdCQUFRLGFBQWE7QUFBQSxFQUMxQixTQUFTLENBQUM7QUFBQSxFQUNWLE1BQU07QUFBQSxJQUNKLGFBQWE7QUFBQSxJQUNiLFVBQVU7QUFBQSxNQUNSLFVBQVU7QUFBQSxJQUNaO0FBQUEsRUFDRjtBQUFBLEVBQ0EsU0FBUztBQUFBLElBQ1AsV0FBVztBQUFBLE1BQ1QsVUFBVTtBQUFBLE1BQ1YsY0FBYztBQUFBLFFBQ1osUUFBUSxDQUFDLGlCQUFpQjtBQUFBLE1BQzVCO0FBQUEsSUFDRixDQUFDO0FBQUEsRUFDSDtBQUNGLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
