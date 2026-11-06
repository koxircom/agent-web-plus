"""Request timing preserves responses and never records dynamic content."""
import json
import unittest
from unittest.mock import patch
from bridge.api.httpd import Handler


class ConnectionTimingTests(unittest.TestCase):
    def handler(self, path, status):
        h=Handler.__new__(Handler);h.path=path;h.headers={'X-Agent-Web-Trace-ID':'private sentinel'}
        def dispatch(write):h._diagnostic_status=status;return 'original-result'
        h._handle_method=dispatch
        return h

    def test_slow_read_keeps_result_and_masks_session_query_and_header(self):
        h=self.handler('/api/sessions/01901234-5678-7000-8000-000000000001/timeline?password=PRIVATE_BODY',200)
        with patch('bridge.api.httpd.time.monotonic',side_effect=[10,12]),self.assertLogs('bridge.api.httpd',level='WARNING') as logs:
            self.assertEqual(h.handle_method(False),'original-result')
        raw=logs.output[0];self.assertNotIn('PRIVATE_BODY',raw);self.assertNotIn('01901234',raw);self.assertNotIn('private sentinel',raw)
        j=json.loads(raw.split('codex_connection ',1)[1]);self.assertEqual(j['route'],'/api/sessions/:id/timeline');self.assertEqual(j['durationMs'],2000);self.assertEqual(j['reason'],'slow_request')

    def test_fast_failure_retains_safe_status_and_trace(self):
        h=self.handler('/api/activity',503);h.headers={'X-Agent-Web-Trace-ID':'01901234-5678-7000-8000-000000000001'}
        with patch('bridge.api.httpd.time.monotonic',side_effect=[10,10.01]),self.assertLogs('bridge.api.httpd',level='WARNING') as logs:
            self.assertEqual(h.handle_method(True),'original-result')
        j=json.loads(logs.output[0].split('codex_connection ',1)[1]);self.assertEqual(j['status'],503);self.assertEqual(j['reason'],'upstream_unavailable');self.assertEqual(j['traceId'],h.headers['X-Agent-Web-Trace-ID'])

    def test_direct_image_response_records_status_without_false_failure(self):
        h=self.handler('/api/desktop-image',200)
        def dispatch(write):h.send_response(200);return 'image-response'
        h._handle_method=dispatch
        with patch('http.server.BaseHTTPRequestHandler.send_response') as sent, patch('bridge.api.httpd.time.monotonic',side_effect=[10,10.01]), patch('bridge.api.httpd.LOG.warning') as log:
            self.assertEqual(h.handle_method(False),'image-response')
        sent.assert_called_once_with(200,None);log.assert_not_called()

    def test_normal_long_poll_does_not_produce_a_slow_request_alarm(self):
        h=self.handler('/api/sessions/01901234-5678-7000-8000-000000000001/changes?after=1',200)
        with patch('bridge.api.httpd.time.monotonic',side_effect=[10,22]),patch('bridge.api.httpd.LOG.warning') as log:
            self.assertEqual(h.handle_method(False),'original-result')
        log.assert_not_called()


if __name__=='__main__':unittest.main()
