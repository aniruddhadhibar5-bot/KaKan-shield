import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

const _requestTimeout = Duration(seconds: 8);
const _maximumResponseBytes = 1024 * 1024;

Future<void> main(List<String> arguments) async {
  if (arguments.length != 1) {
    stderr.writeln('Usage: dart run bin/health_check.dart <http(s)://host[:port]>');
    exitCode = 64;
    return;
  }

  final Uri baseUri;
  try {
    baseUri = Uri.parse(arguments.single);
    if (!const ['http', 'https'].contains(baseUri.scheme)
        || baseUri.host.isEmpty
        || baseUri.userInfo.isNotEmpty
        || baseUri.hasQuery
        || baseUri.hasFragment) {
      throw const FormatException(
        'Use an HTTP(S) base URL without credentials, query parameters, or a fragment.',
      );
    }
  } on FormatException catch (error) {
    stderr.writeln('Invalid server URL: ${error.message}');
    exitCode = 64;
    return;
  }

  final client = HttpClient()
    ..connectionTimeout = _requestTimeout
    ..maxConnectionsPerHost = 1;
  final pathSegments = baseUri.pathSegments.where((segment) => segment.isNotEmpty).toList();
  pathSegments.addAll(['api', 'health']);
  final healthUri = baseUri.replace(pathSegments: pathSegments, query: null, fragment: null);
  final stopwatch = Stopwatch()..start();

  try {
    final request = await client.getUrl(healthUri).timeout(_requestTimeout);
    request
      ..followRedirects = false
      ..headers.set(HttpHeaders.acceptHeader, ContentType.json.mimeType)
      ..headers.set(HttpHeaders.userAgentHeader, 'SentinelHealthClient/0.1');
    final response = await request.close().timeout(_requestTimeout);
    if (response.statusCode != HttpStatus.ok) {
      throw HttpException('Health endpoint returned HTTP ${response.statusCode}.', uri: healthUri);
    }

    final body = BytesBuilder(copy: false);
    await for (final chunk in response.timeout(_requestTimeout)) {
      if (body.length + chunk.length > _maximumResponseBytes) {
        throw const FormatException('Health response exceeds the 1 MiB safety limit.');
      }
      body.add(chunk);
    }

    final decoded = jsonDecode(utf8.decode(body.takeBytes()));
    if (decoded is! Map<String, dynamic>
        || decoded['status'] != 'healthy'
        || decoded['service'] != 'Sentinel Business Shield') {
      throw const FormatException('The endpoint did not return a healthy Sentinel response.');
    }

    stopwatch.stop();
    stdout.writeln('Service: ${decoded['service']}');
    stdout.writeln('Status: ${decoded['status']}');
    stdout.writeln('Response time: ${stopwatch.elapsedMilliseconds} ms');
  } on TimeoutException {
    stderr.writeln('Health check timed out after ${_requestTimeout.inSeconds} seconds.');
    exitCode = 1;
  } on SocketException {
    stderr.writeln('Could not connect to the configured health endpoint.');
    exitCode = 1;
  } on HttpException catch (error) {
    stderr.writeln('Health check failed: ${error.message}');
    exitCode = 1;
  } on FormatException catch (error) {
    stderr.writeln('Health response is invalid: ${error.message}');
    exitCode = 1;
  } on IOException {
    stderr.writeln('Could not read the health response.');
    exitCode = 1;
  } finally {
    client.close(force: true);
  }
}
