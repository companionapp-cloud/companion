Pod::Spec.new do |s|
  s.name           = 'WatchBridge'
  s.version        = '1.0.0'
  s.summary        = 'WatchConnectivity bridge for the Companion watch app'
  s.description    = 'Sends the today-tasks snapshot from the phone to the paired watch via WCSession.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # WCSession lives in WatchConnectivity.framework (part of the iOS SDK).
  s.frameworks = 'WatchConnectivity'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "*.{h,m,mm,swift}"
end
