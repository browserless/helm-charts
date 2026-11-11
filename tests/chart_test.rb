require 'yaml'
require 'json'
require 'open3'
require 'tmpdir'
require 'fileutils'
require 'rubygems/package'
require 'zlib'

HELM = ENV.fetch('HELM', 'helm')
CHART = File.expand_path('../charts/browserless', __dir__)
def check(condition, message)
  raise message unless condition
end
def helm(*args)
  Open3.capture3(HELM, *args)
end
def render(release = 'alpha', values = {})
  Dir.mktmpdir do |dir|
    file = File.join(dir, 'values.json')
    values['token'] = {'existingSecret' => 'browserless-token'}.merge(values.fetch('token', {}))
    File.write(file, JSON.generate(values))
    out, err, status = helm('template', release, CHART, '-f', file)
    check(status.success?, err)
    YAML.load_stream(out).compact
  end
end

check(File.file?(File.join(CHART, 'Chart.yaml')), 'chart must exist')
out, err, status = helm('template', 'alpha', CHART)
check(!status.success? && (out + err).include?('existingSecret'), 'missing secret must fail')
[
  {'token' => {'existingSecret' => ''}},
  {'token' => {'existingSecret' => 'bad/name'}},
  {'token' => {'key' => ''}},
  {'image' => {'tag' => 123}},
  {'image' => {'digest' => 'bad'}},
  {'service' => {'port' => '3000'}},
  {'resources' => []},
  {'persistence' => {'mountPath' => 'relative'}},
  {'replicaCount' => 2},
  {'token' => {'value' => 'plaintext'}},
  {'concurrent' => 0},
  {'concurrent' => -1},
  {'queued' => -1},
  {'timeout' => 0},
  {'timeout' => '30000'},
  {'resources' => {'limits' => {'memory' => '2mi'}}},
  {'resources' => {'limits' => {'cpu' => '1ki'}}}
].each do |values|
  Dir.mktmpdir do |dir|
    path = File.join(dir, 'invalid.json')
    values['token'] = {'existingSecret' => 'browserless-token'}.merge(values.fetch('token', {}))
    File.write(path, JSON.generate(values))
    _, error, result = helm('template', 'alpha', CHART, '-f', path)
    check(!result.success? && error.include?('schema'), "invalid values accepted: #{values}")
  end
end

docs = render
check(docs.map { |d| d['kind'] }.sort == %w[Deployment Service], 'only Deployment and Service')
deploy = docs.find { |d| d['kind'] == 'Deployment' }
service = docs.find { |d| d['kind'] == 'Service' }
pod = deploy['spec']['template']['spec']
container = pod['containers'].first
# Dependabot updates the tag, so derive it; it must stay a pinned release that appVersion names.
default_tag = YAML.load_file(File.join(CHART, 'values.yaml'))['image']['tag']
check(default_tag.match?(/\Av\d+\.\d+\.\d+\z/), "default image tag must be a pinned release, not #{default_tag}")
check(container['image'] == "ghcr.io/browserless/chromium:#{default_tag}", 'public pinned image')
chart_meta = YAML.load_file(File.join(CHART, 'Chart.yaml'))
check(chart_meta['appVersion'] == default_tag.delete_prefix('v'), 'appVersion names the default image release')
# Helm publishes the first source as the OCI package's org.opencontainers.image.source.
check(chart_meta['sources'].first == 'https://github.com/browserless/helm-charts', 'the chart repository is the first source')
check(deploy['spec']['replicas'] == 1, 'single replica')
check(deploy['spec']['strategy']['type'] == 'Recreate', 'no overlapping PVC users during upgrade')
check(service['spec']['type'] == 'ClusterIP', 'internal service')
check(service['spec']['selector'] == deploy['spec']['selector']['matchLabels'], 'selectors agree')
check(pod['automountServiceAccountToken'] == false, 'no Kubernetes API token')
token = container['env'].find { |e| e['name'] == 'TOKEN' }
check(token == {'name' => 'TOKEN', 'valueFrom' => {'secretKeyRef' => {'name' => 'browserless-token', 'key' => 'TOKEN'}}}, 'secret reference only')
check(container['command'].join(' ').include?('TOKEN:?'), 'empty secret fails closed')
# The image's /bin/sh (dash) matches bytes; LC_ALL=C makes other shells do the same.
_, error, result = Open3.capture3({'TOKEN' => '', 'LC_ALL' => 'C'}, *container['command'])
check(!result.success? && error.include?('TOKEN must be nonempty'), 'empty token actually blocks entrypoint')
["token\n", 'two words', "\ttoken", ' ', "tok\u00e9n", "tok\u20acn", "tok\x7fn"].each do |value|
  _, error, result = Open3.capture3({'TOKEN' => value, 'LC_ALL' => 'C'}, *container['command'])
  check(!result.success? && error.include?('printable ASCII'), "unusable token accepted: #{value.inspect}")
end
_, error, = Open3.capture3({'TOKEN' => 'valid-Token_1.x~!', 'LC_ALL' => 'C'}, *container['command'])
check(!error.include?('TOKEN must'), 'valid token passes the entrypoint guard')
env = container['env'].to_h { |e| [e['name'], e['value']] }
check(env.values_at('CONCURRENT', 'QUEUED', 'TIMEOUT') == %w[10 10 30000], 'admission limits default to the image defaults')
check(!env.key?('PERSISTENCE_MOUNT_PATH'), 'no writability check without a volume')
check(container['env'].find { |e| e['name'] == 'DEBUG' }['value'].split(',').include?('-**:debug'), 'debug logs that print TOKEN stay disabled')
check(pod['securityContext'] == {'fsGroup' => 999, 'fsGroupChangePolicy' => 'OnRootMismatch', 'seccompProfile' => {'type' => 'RuntimeDefault'}}, 'restricted pod defaults')
check(container['securityContext'] == {'runAsNonRoot' => true, 'runAsUser' => 999, 'allowPrivilegeEscalation' => false, 'capabilities' => {'drop' => ['ALL']}}, 'restricted container defaults')
check(pod['volumes'] == [{'name' => 'shm', 'emptyDir' => {'medium' => 'Memory', 'sizeLimit' => '1Gi'}}], 'memory-backed shared memory')
check(container['startupProbe'].key?('tcpSocket') && container['livenessProbe'].key?('tcpSocket'), 'capacity must not restart pods')
probe = container['readinessProbe']['exec']['command']
check(probe[0..1] == ['node', '-e'], 'readiness uses image Node runtime')
check(probe.last.include?('text/plain') && probe.last.include?('/pressure') && probe.last.include?('process.env.TOKEN'), 'authenticated saturation-sensitive readiness')

digest = 'sha256:' + 'a' * 64
custom = render('beta', {
  'concurrent' => 3, 'queued' => 0, 'timeout' => 1_800_000,
  'image' => {'repository' => 'example.org/chromium', 'tag' => 'other', 'digest' => digest},
  'token' => {'existingSecret' => 'custom-token', 'key' => 'password'},
  'service' => {'port' => 8080},
  'resources' => {'requests' => {'cpu' => '250m', 'memory' => '512Mi'}, 'limits' => {'cpu' => 2, 'memory' => '3Gi'}},
  'shmSizeLimit' => '512Mi',
  'persistence' => {'existingClaim' => 'browser-data', 'mountPath' => '/data'},
  'nodeSelector' => {'kubernetes.io/arch' => 'amd64'},
  'tolerations' => [{'key' => 'browser', 'operator' => 'Exists'}],
  'affinity' => {'nodeAffinity' => {}},
  'podSecurityContext' => {'fsGroup' => 999},
  'securityContext' => {'runAsUser' => 999, 'runAsNonRoot' => true},
  'imagePullSecrets' => [{'name' => 'registry'}]
})
custom_deploy = custom.find { |d| d['kind'] == 'Deployment' }
cp = custom_deploy['spec']['template']['spec']
cc = cp['containers'].first
check(cc['image'] == "example.org/chromium@#{digest}", 'digest wins over tag')
check(cc['env'].first['valueFrom']['secretKeyRef'] == {'name' => 'custom-token', 'key' => 'password'}, 'custom secret')
check(custom.find { |d| d['kind'] == 'Service' }['spec']['ports'].first['port'] == 8080, 'custom service port')
check(cc['resources']['limits'] == {'cpu' => 2, 'memory' => '3Gi'}, 'custom resources, including a plain-number quantity')
custom_env = cc['env'].to_h { |e| [e['name'], e['value']] }
check(custom_env.values_at('CONCURRENT', 'QUEUED', 'TIMEOUT') == %w[3 0 1800000], 'typed admission limits, never in exponent form')
check(custom_env['PERSISTENCE_MOUNT_PATH'] == '/data', 'mounted volume path passed to the writability check')
Dir.mktmpdir do |dir|
  readonly = File.join(dir, 'readonly')
  Dir.mkdir(readonly, 0o555)
  _, error, result = Open3.capture3({'TOKEN' => 'token', 'PERSISTENCE_MOUNT_PATH' => readonly, 'LC_ALL' => 'C'}, *cc['command'])
  check(!result.success? && error.include?('is not writable by UID'), 'unwritable volume stops the container')
  _, error, = Open3.capture3({'TOKEN' => 'token', 'PERSISTENCE_MOUNT_PATH' => dir, 'LC_ALL' => 'C'}, *cc['command'])
  check(!error.include?('not writable'), 'writable volume passes the check')
end
check(cp['volumes'].last['persistentVolumeClaim']['claimName'] == 'browser-data', 'existing PVC')
check(cc['volumeMounts'].last['mountPath'] == '/data', 'PVC mount')
check(cp['volumes'].first['emptyDir']['sizeLimit'] == '512Mi', 'custom shm')
check(cp['nodeSelector']['kubernetes.io/arch'] == 'amd64' && cp['tolerations'].first['key'] == 'browser' && cp['affinity'].key?('nodeAffinity'), 'placement')
check(cp['securityContext']['fsGroup'] == 999 && cc['securityContext']['runAsUser'] == 999, 'security overrides')
check(cp['imagePullSecrets'] == [{'name' => 'registry'}], 'image pull secrets')
check((docs.map { |d| d['metadata']['name'] } & custom.map { |d| d['metadata']['name'] }).empty?, 'release names isolated')
check(deploy['spec']['selector']['matchLabels'] != custom_deploy['spec']['selector']['matchLabels'], 'release selectors isolated')
long = render('a' * 53)
check(long.all? { |d| d['metadata']['name'].size <= 63 }, 'valid longest Helm release name')
%w[123 1abc a.b].each do |release|
  _, error, result = helm('template', release, CHART, '--set', 'token.existingSecret=browserless-token')
  check(!result.success? && error.include?('release name must start with a lowercase letter'), "invalid Service name prefix accepted: #{release}")
end

_, err, status = helm('lint', CHART, '--strict', '--set', 'token.existingSecret=browserless-token')
check(status.success?, err)
Dir.mktmpdir do |dir|
  _, err, status = helm('package', CHART, '--destination', dir)
  check(status.success?, err)
  archive = Dir[File.join(dir, '*.tgz')].fetch(0)
  names = []
  Zlib::GzipReader.open(archive) do |gzip|
    Gem::Package::TarReader.new(gzip) do |tar|
      tar.each do |entry|
        next unless entry.file?
        names << entry.full_name
        check(!entry.read.match?(%r{/Users/|/home/\w|\.worktrees|\.amp/}), "local path in package: #{entry.full_name}")
      end
    end
  end
  check(names.sort == %w[Chart.yaml values.yaml values.schema.json templates/deployment.yaml templates/service.yaml].map { |p| "browserless/#{p}" }.sort, "unexpected package entries: #{names}")
  # Release Please writes CHANGELOG.md into the chart directory; it must not ship.
  # With SOURCE_DATE_EPOCH (as publish-chart.sh sets it) the package is reproducible.
  copy = File.join(dir, 'copy', 'browserless')
  FileUtils.mkdir_p(File.dirname(copy))
  FileUtils.cp_r(CHART, copy)
  File.write(File.join(copy, 'CHANGELOG.md'), "# Changelog\n")
  File.utime(Time.at(0), Time.at(0), *Dir[File.join(copy, '**', '*')])
  _, err, status = Open3.capture3({'SOURCE_DATE_EPOCH' => '1700000000'}, HELM, 'package', copy, '--destination', File.join(dir, 'r1'))
  check(status.success?, err)
  _, err, status = Open3.capture3({'SOURCE_DATE_EPOCH' => '1700000000'}, HELM, 'package', CHART, '--destination', File.join(dir, 'r2'))
  check(status.success?, err)
  a, b = %w[r1 r2].map { |d| File.binread(Dir[File.join(dir, d, '*.tgz')].fetch(0)) }
  check(a == b, 'package must be reproducible and exclude CHANGELOG.md and .helmignore')
  _, err, status = helm('template', 'packaged', archive, '--set', 'token.existingSecret=browserless-token')
  check(status.success?, err)
  # Helm always passes `global` to dependencies, even when the parent sets none.
  parent = File.join(dir, 'parent')
  FileUtils.mkdir_p(File.join(parent, 'charts'))
  File.write(File.join(parent, 'Chart.yaml'), "apiVersion: v2\nname: parent\nversion: 1.0.0\n")
  FileUtils.cp(archive, File.join(parent, 'charts'))
  [[], ['--set', 'global.environment=test']].each do |extra|
    out, err, status = helm('template', 'parent', parent, '--set', 'browserless.token.existingSecret=browserless-token', *extra)
    check(status.success? && out.include?('kind: Deployment'), "dependency render failed: #{err}")
  end
end
puts 'PASS: schema, defaults, overrides, digest, release isolation, lint, package hygiene, packaged and dependency render'
