const { app } = require('electron')
const path     = require('path')

module.exports = (options) => {
  const cmd = app.isPackaged
    ? path.join(process.resourcesPath, 'sox')
    : '/opt/homebrew/bin/sox'

  let args = [
    '--default-device',
    '--no-show-progress',
    '--rate', options.sampleRate,
    '--channels', options.channels,
    '--encoding', 'signed-integer',
    '--bits', '16',
    '--type', options.audioType,
    '-',
  ]

  if (options.endOnSilence) {
    args = args.concat([
      'silence', '1', '0.1', options.thresholdStart || options.threshold + '%',
      '1', options.silence, options.thresholdEnd || options.threshold + '%',
    ])
  }

  const spawnOptions = {
    env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH || ''}` },
  }

  if (options.device) {
    spawnOptions.env.AUDIODEV = options.device
  }

  return { cmd, args, spawnOptions }
}
