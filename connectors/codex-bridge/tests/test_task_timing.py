import threading
import unittest
from bridge.features.sessions.model import normalize_state
from bridge.features.sessions.side_chat import SideChat
from bridge.features.sessions.timeline import Timeline

class NativeTaskTimingTests(unittest.TestCase):
    def state(self, status='active', started=1793760355):
        return {'id':'fixture','requests':[],'threadRuntimeStatus':{'type':status},'turns':[
            {'turnId':'older','status':'completed','startedAt':1793750000,'items':[]},
            {'turnId':'native-turn','status':'inProgress' if status=='active' else 'completed','startedAt':started,'items':[]}]}

    def test_metadata_only_uses_original_native_start_and_id(self):
        expected={'taskId':'native-turn','startedAt':1793760355000}
        for include in (True,False):
            result=normalize_state(self.state(),include_turns=include)
            self.assertEqual(result['taskTiming'],expected)
        timeline=Timeline()
        timeline.update({**normalize_state(self.state()),'sequence':1})
        self.assertEqual(timeline.page()['meta']['taskTiming'],expected)
        timeline.update({**normalize_state(self.state(),include_turns=False),'sequence':1})
        self.assertEqual(timeline.changes(1,timeline.epoch,None)['meta']['taskTiming'],expected)

    def test_idle_and_missing_timing_do_not_invent_a_start(self):
        self.assertIsNone(normalize_state(self.state(status='idle'))['taskTiming'])
        for invalid in (None,0,True,'invalid'):
            self.assertIsNone(normalize_state(self.state(started=invalid))['taskTiming'])

    def test_turn_events_retain_native_start_and_completion_fields(self):
        chat=SideChat.__new__(SideChat)
        chat.lock=threading.RLock();chat.id='fixture';chat.ready=True;chat.closed=False
        chat.submissions={};chat.queue_event=threading.Event();chat.state=self.state()
        chat.state['turns']=[]
        chat._event({'method':'turn/started','params':{'threadId':'fixture','turn':{
            'id':'native-turn','status':'inProgress','startedAt':1793760355}}})
        self.assertEqual(normalize_state(chat.state)['taskTiming'],{'taskId':'native-turn','startedAt':1793760355000})
        chat._event({'method':'turn/completed','params':{'threadId':'fixture','turn':{
            'id':'native-turn','status':'completed','startedAt':1793760355,'completedAt':1793760415,'durationMs':60000}}})
        self.assertEqual(chat.state['turns'][0]['durationMs'],60000)
        self.assertIsNone(normalize_state(chat.state)['taskTiming'])

if __name__=='__main__':
    unittest.main()
