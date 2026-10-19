// Electron Forge packaging configuration for the Windows installer.
module.exports = {
  packagerConfig: {
    asar: true,
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: {
        name: 'ANJ_BCA_Manager',
      },
    },
  ],
};
