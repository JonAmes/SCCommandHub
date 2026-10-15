import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.sccommandhub.app',
  appName: 'SC Command Hub',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
}

export default config