Pod::Spec.new do |s|
  s.name           = 'ViewFrame'
  s.version        = '1.0.0'
  s.summary        = 'Measures React views with UIKit'
  s.description    = 'Where a React view really is in its window, for the tutorial spotlight.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "*.{h,m,mm,swift}"
end
