export default {
  expo: {
    name: 'Companion',
    slug: 'companion-website',
    scheme: 'companion-website',
    platforms: ['web'],
    web: {
      bundler: 'metro',
      output: 'static',
      favicon: './public/favicon-32.png',
    },
    plugins: ['expo-router'],
  },
}
