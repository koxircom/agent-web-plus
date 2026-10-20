import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch, Mock
from bridge.clients.codex.runtime_update import RuntimeUpdate

class RuntimeUpdateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.exe = self.root / 'codex'
        self.exe.write_text('fixture')
        self.c = RuntimeUpdate(self.exe, self.root, self.root/'app-server-control/socket',
            {'enabled':True,'quietSeconds':15,'stateDirectory':str(self.root/'activation')})
        self.snapshot = {'installed':'0.163.0','running':'0.162.1','status':'running'}
        self.peer = {'pid':123,'started':'456'}
        self.c.probe = Mock(return_value=self.snapshot)
        self.c.activity = Mock(return_value={'busy':False,'peer':self.peer})
        self.c.restart = Mock(return_value=True)
    def tearDown(self):
        self.tmp.cleanup()
    def ready(self):
        self.c.step()
        state = self.c.read();state['idleSince'] -= 20;self.c.write(state)
    def test_unknown_never_restarts_and_stopped_does_not_auto_start(self):
        for state in ('unknown','stopped'):
            self.c.probe.return_value = {**self.snapshot,'running':None,'status':state}
            with patch.object(self.c,'command') as command:
                self.assertEqual(self.c.step()['phase'],'waiting_for_idle')
                command.assert_not_called()
        self.c.restart.assert_not_called()
    def test_busy_resets_quiet_window(self):
        self.ready();self.c.activity.return_value={'busy':True,'message':'busy','peer':self.peer}
        self.assertEqual(self.c.step()['message'],'busy')
        self.assertNotIn('idleSince',self.c.read());self.c.restart.assert_not_called()
    def test_quiet_then_activate_and_verify_actual(self):
        self.assertEqual(self.c.step()['phase'],'waiting_for_idle')
        self.c.restart.assert_not_called()
        state=self.c.read();state['idleSince']-=20;self.c.write(state)
        self.c.probe.side_effect=[self.snapshot,{**self.snapshot,'running':'0.163.0'}]
        self.assertEqual(self.c.step()['phase'],'current')
        self.c.restart.assert_called_once_with(self.peer)
    def test_changed_identity_restarts_quiet_window(self):
        self.ready();self.c.activity.return_value={'busy':False,'peer':{'pid':124,'started':'457'}}
        self.assertEqual(self.c.step()['phase'],'waiting_for_idle');self.c.restart.assert_not_called()
    def test_new_work_after_quiet_defers(self):
        self.ready();self.c.restart.return_value=False
        self.assertEqual(self.c.step()['message'],'检测到新任务，切换已延期')
        self.assertNotIn('restartRequested',self.c.read())
    def test_observation_failure_fails_closed(self):
        self.c.activity.side_effect=RuntimeError('unavailable')
        self.assertEqual(self.c.step()['phase'],'error');self.c.restart.assert_not_called()
    def test_wrong_running_version_is_not_success(self):
        self.ready();self.assertEqual(self.c.step()['phase'],'error')
        self.assertTrue(self.c.read()['restartRequested'])
    def test_recover_only_a_previously_requested_handoff(self):
        self.ready();self.c.write({**self.c.read(),'restartRequested':True})
        self.c.probe.side_effect=[{**self.snapshot,'running':None,'status':'stopped'},
                                {**self.snapshot,'running':'0.163.0'}]
        with patch.object(self.c,'command') as command:
            self.assertEqual(self.c.step()['phase'],'current')
            self.assertEqual(command.call_args.args[0],['app-server','daemon','start'])
    def test_disabled_is_read_only(self):
        self.c.enabled=False
        self.assertEqual(self.c.step()['phase'],'manual')
        self.c.restart.assert_not_called();self.c.probe.assert_not_called()
    def test_status_separates_versions_and_no_activation_on_read(self):
        status=self.c.status(self.snapshot)
        self.assertEqual(status['codexCliInstalledVersion'],'0.163.0')
        self.assertEqual(status['codexCliRunningVersion'],'0.162.1')
        self.assertEqual(status['codexCliActivationState'],'waiting_for_idle')
        self.c.restart.assert_not_called()
    def test_probe_reports_distinct_native_versions(self):
        del self.c.probe
        native={'status':'running','socketPath':self.c.control_socket,'appServerVersion':'0.162.1'}
        with patch.object(self.c,'command',side_effect=[SimpleNamespace(stdout='codex-cli 0.163.0\n'),SimpleNamespace(stdout=json.dumps(native))]):
            self.assertEqual(self.c.probe(),self.snapshot)
    def test_activity_blocks_tasks_queue_goal_and_unreadable_status(self):
        del self.c.activity
        for status,queue,goal in [('active',[],None),('idle',[{'id':'q'}],None),('idle',[],{'status':'active'}),('unknown',[],None)]:
            with self.subTest(status=status,queue=queue,goal=goal), patch.object(self.c,'peer',return_value=self.peer),patch('bridge.clients.codex.runtime_update.SharedRuntime') as runtime:
                replies={'thread/loaded/list':{'data':['thread']},'thread/read':{'thread':{'status':{'type':status}}},
                    'thread/queue/list':{'data':queue},'thread/goal/get':{'goal':goal}}
                runtime.return_value.request.side_effect=lambda method,*a,**kw:replies[method]
                self.assertTrue(self.c.activity()['busy']);runtime.return_value.close.assert_called_once()
    def test_restart_final_check_prevents_any_process_command(self):
        del self.c.restart
        self.c.activity.return_value={'busy':True,'peer':self.peer}
        with patch.object(self.c,'command') as command,patch('os.kill') as kill:
            self.assertFalse(self.c.restart(self.peer));command.assert_not_called();kill.assert_not_called()

    def test_downgrade_never_activates_automatically(self):
        self.c.probe.return_value={**self.snapshot,'installed':'0.161.0'}
        self.assertEqual(self.c.step()['phase'],'error');self.c.restart.assert_not_called()
    def test_native_handoff_pins_installed_cli_instead_of_plain_restart(self):
        del self.c.restart
        with patch.object(self.c,'peer',return_value=self.peer),patch('pathlib.Path.read_bytes',return_value=b'PATH=/bin\0'),patch.object(self.c,'command') as command:
            self.assertTrue(self.c.restart(self.peer))
            self.assertEqual(command.call_args.args[0],['app-server','daemon','update','--from-cli','--yes'])
