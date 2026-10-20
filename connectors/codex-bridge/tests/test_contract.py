"""No Codex process or real workspace writes: import closure and native ownership contracts."""
import base64,sys,tempfile,threading,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from bridge.api.httpd import GatewayServer
from bridge.clients.codex.standalone import StandaloneBridge,Runtime
from bridge.features.workspace.workspace import Workspace

class ContractTests(unittest.TestCase):
    def test_protocol_descriptor_is_packaged_and_matches_implemented_contract(self):
        descriptor = StandaloneBridge.compatibility
        self.assertEqual(descriptor['protocol'], 'pi-web-codex')
        self.assertEqual(descriptor['version'], 1)
        self.assertIn('queue-v2', descriptor['capabilities'])
        self.assertIn('prompt-identity-v1', descriptor['capabilities'])

    def test_source_package_imports_and_lazy_runtime(self):
        runtime=Runtime('/nonexistent/codex', '/not-used', '/not-used', lambda event: None)
        self.assertIsNone(runtime.process)
        self.assertFalse(runtime.running)
        runtime.close()
    def test_automatic_queue_is_chosen_under_execution_lock(self):
        class Chat:
            actions=threading.RLock()
            def refresh_shared_state(self):self_test.assertTrue(self.actions._is_owned())
            def view(self):return {'status':'active','requests':[]}
            def send(self,*args,**kwargs):
                self_test.assertTrue(self.actions._is_owned())
                return kwargs
        class Bridge:
            _adopt_record=lambda self,thread: None
            session=lambda self,thread: Chat()
            catalog_reader=None
            _record=lambda self,thread: {}
        self_test=self
        result=StandaloneBridge.send(Bridge(),'thread','text','submission',mode='auto',client_request_id='pi-request-12345678')
        self.assertEqual(result['mode'],'queue')
        self.assertEqual(result['client_request_id'],'pi-request-12345678')
    def test_file_upload_rejects_escape_symlinks_and_different_contents(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)/'project';root.mkdir()
            workspace=Workspace(root)
            data=base64.b64encode(b'original').decode()
            workspace.upload('sample.txt',data)
            self.assertEqual((root/'sample.txt').read_bytes(),b'original')
            with self.assertRaises((ValueError,PermissionError)):
                workspace.upload('sample.txt',base64.b64encode(b'different').decode())
            with self.assertRaises((ValueError,PermissionError)):
                workspace.upload('../escape.txt',data)
            (root/'link').symlink_to(Path(directory))
            with self.assertRaises((ValueError,PermissionError,OSError)):
                workspace.upload('link/escape.txt',data)
            self.assertFalse((Path(directory)/'escape.txt').exists())

if __name__=='__main__':unittest.main()
