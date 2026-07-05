Pod::Spec.new do |s|
  s.name           = 'CompanionCore'
  s.version        = '1.0.0'
  s.summary        = 'Companion Go core, bound to iOS via gomobile'
  s.description    = 'Wraps Core.xcframework (gomobile bind of core/cmd/mobile) as an Expo module.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  # gomobile artifact (built by `make mobile-artifacts`, copied to ios/vendor).
  s.vendored_frameworks = 'vendor/Core.xcframework'

  # Only compile the module's own Swift — do not recurse into the vendored framework.
  s.source_files = "*.{h,m,mm,swift}"
end
