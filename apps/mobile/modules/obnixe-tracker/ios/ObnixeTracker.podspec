Pod::Spec.new do |s|
  s.name           = 'ObnixeTracker'
  s.version        = '1.0.0'
  s.summary        = 'Obnixe activity recorder'
  s.description    = 'Records Core Location, Core Motion and Core Bluetooth heart rate samples into the .ojr journal.'
  s.license        = { type: 'Proprietary' }
  s.author         = 'Obnixe'
  s.homepage       = 'https://github.com/JamesStandbridge/obnixe'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'ActivityKit', 'CoreBluetooth', 'CoreLocation', 'CoreMotion'

  s.source_files = '**/*.swift'
  s.exclude_files = 'Tests/**/*'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.test_spec 'Tests' do |test_spec|
    test_spec.source_files = 'Tests/**/*.swift'
  end
end
