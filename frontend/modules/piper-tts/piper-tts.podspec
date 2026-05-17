require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'piper-tts'
  s.version        = package['version']
  s.summary        = package['description']
  s.homepage       = 'https://github.com/beppeaudiobooks/piper-tts'
  s.license        = { :type => 'MIT' }
  s.authors        = 'Beppe Audiobooks'
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.source_files   = 'ios/**/*.{h,m,mm,swift}'
  s.dependency 'React-Core'
end
