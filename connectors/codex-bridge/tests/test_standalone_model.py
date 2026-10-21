import copy
import sys
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bridge.clients.codex.standalone import Chat, StandaloneBridge


class StandaloneModelTests(unittest.TestCase):
    def test_settings_updates_native_and_survives_shared_refresh(self):
        calls = []
        thread_id = "test-thread-id"

        class MockBackend:
            shared = True
            process = SimpleNamespace(poll=lambda: None)

            def request(self, method, params, timeout=30):
                calls.append((method, copy.deepcopy(params)))
                if method == "thread/settings/update":
                    return {"ok": True}
                if method == "thread/resume":
                    return {
                        "model": "model-6.1",
                        "reasoningEffort": "high",
                        "collaborationMode": {
                            "mode": "plan",
                            "settings": {
                                "model": "model-6.1",
                                "reasoning_effort": "high",
                                "developer_instructions": "custom-instructions",
                            },
                        },
                        "thread": {
                            "id": thread_id,
                            "cwd": "/workspace/test",
                            "status": {"type": "idle"},
                        },
                    }
                return {}

        backend = MockBackend()
        initial_resume = {
            "model": "model-5.2",
            "reasoningEffort": "medium",
            "collaborationMode": {
                "mode": "plan",
                "settings": {
                    "model": "model-5.2",
                    "reasoning_effort": "medium",
                    "developer_instructions": "custom-instructions",
                },
            },
            "thread": {
                "id": thread_id,
                "cwd": "/workspace/test",
                "status": {"type": "idle"},
                "turns": [],
            },
        }

        class MockBridge:
            registry_lock = threading.RLock()
            records = {
                "threads": {
                    thread_id: {
                        "title": "Test Chat",
                        "cwd": "/workspace/test",
                        "model": "model-5.2",
                        "effort": "medium",
                        "submissions": {},
                    }
                }
            }
            uploads = None
            catalog_reader = None

            def _sandbox_type(self, val):
                return val

            def _adopt_record(self, tid):
                pass

            def save(self):
                pass

            def catalog(self, tid, kind="models"):
                return {
                    "models": [
                        {"id": "model-6.1", "efforts": ["low", "medium", "high"]}
                    ]
                }

        bridge = MockBridge()
        chat = Chat(bridge, thread_id, initial_resume, backend)
        bridge.live = {thread_id: chat}
        bridge.session = lambda tid, **kw: chat

        self.assertEqual(chat.state["latestModel"], "model-5.2")
        self.assertEqual(chat.state["latestReasoningEffort"], "medium")

        # 1. 前端调用 settings 选择 6.1
        bridge_instance = StandaloneBridge.__new__(StandaloneBridge)
        bridge_instance.records = bridge.records
        bridge_instance.registry_lock = bridge.registry_lock
        bridge_instance._adopt_record = lambda tid: None
        bridge_instance.save = lambda: None
        bridge_instance.session = lambda tid, **kw: chat
        bridge_instance.catalog = lambda tid, kind="models": {
            "models": [{"id": "model-6.1", "efforts": ["high"]}]
        }

        result = bridge_instance.settings(thread_id, "model-6.1", "high")
        self.assertEqual(result["model"], "model-6.1")
        self.assertEqual(chat.state["latestModel"], "model-6.1")
        self.assertEqual(chat.state["latestReasoningEffort"], "high")

        # 验证发送给原生的 thread/settings/update 参数
        update_calls = [c for c in calls if c[0] == "thread/settings/update"]
        self.assertEqual(len(update_calls), 1)
        update_params = update_calls[0][1]
        self.assertEqual(update_params["threadId"], thread_id)
        self.assertEqual(update_params["model"], "model-6.1")
        self.assertEqual(update_params["effort"], "high")
        # collaborationMode 必须保持原有 mode ('plan')，原有 developer_instructions，同步 model 和 reasoning_effort
        self.assertEqual(update_params["collaborationMode"]["mode"], "plan")
        self.assertEqual(
            update_params["collaborationMode"]["settings"]["model"], "model-6.1"
        )
        self.assertEqual(
            update_params["collaborationMode"]["settings"]["reasoning_effort"], "high"
        )
        self.assertEqual(
            update_params["collaborationMode"]["settings"]["developer_instructions"],
            "custom-instructions",
        )

        # 2. 模拟后续 send 调用 refresh_shared_state，验证不会回滚为旧模型
        chat.refresh_shared_state()
        self.assertEqual(chat.state["latestModel"], "model-6.1")
        self.assertEqual(chat.state["latestReasoningEffort"], "high")
        self.assertEqual(bridge.records["threads"][thread_id]["model"], "model-6.1")
        self.assertEqual(bridge.records["threads"][thread_id]["effort"], "high")

    def test_settings_rejection_or_unknown_does_not_fake_success(self):
        thread_id = "reject-thread-id"

        class RejectBackend:
            shared = True
            process = SimpleNamespace(poll=lambda: None)

            def request(self, method, params, timeout=30):
                if method == "thread/settings/update":
                    raise RuntimeError("Native CLI rejected model update")
                return {}

        initial_resume = {
            "model": "model-5.2",
            "reasoningEffort": "low",
            "thread": {
                "id": thread_id,
                "cwd": "/workspace/test",
                "status": {"type": "idle"},
                "turns": [],
            },
        }

        class MockBridge:
            registry_lock = threading.RLock()
            records = {
                "threads": {
                    thread_id: {
                        "title": "Test Chat",
                        "cwd": "/workspace/test",
                        "model": "model-5.2",
                        "effort": "low",
                        "submissions": {},
                    }
                }
            }
            uploads = None
            catalog_reader = None

            def _sandbox_type(self, val):
                return val

            def _adopt_record(self, tid):
                pass

            def save(self):
                pass

        bridge = MockBridge()
        chat = Chat(bridge, thread_id, initial_resume, RejectBackend())

        bridge_instance = StandaloneBridge.__new__(StandaloneBridge)
        bridge_instance.records = bridge.records
        bridge_instance.registry_lock = bridge.registry_lock
        bridge_instance._adopt_record = lambda tid: None
        bridge_instance.save = lambda: None
        bridge_instance.session = lambda tid, **kw: chat
        bridge_instance.catalog = lambda tid, kind="models": {
            "models": [{"id": "unknown-model", "efforts": ["high"]}]
        }

        # 原生拒绝时必须抛出异常，绝不能假成功
        with self.assertRaises(RuntimeError):
            bridge_instance.settings(thread_id, "unknown-model", "high")

        # 本地状态绝不修改，保持原状
        self.assertEqual(chat.state["latestModel"], "model-5.2")
        self.assertEqual(chat.state["latestReasoningEffort"], "low")
        self.assertEqual(bridge.records["threads"][thread_id]["model"], "model-5.2")

    def test_settings_does_not_affect_running_turn_and_no_fake_queue_capabilities(self):
        thread_id = "running-thread-id"

        class MockBackend:
            shared = True
            process = SimpleNamespace(poll=lambda: None)

            def request(self, method, params, timeout=30):
                if method == "thread/settings/update":
                    return {"ok": True}
                if method == "thread/resume":
                    return {
                        "model": "model-6.1",
                        "reasoningEffort": "high",
                        "collaborationMode": {
                            "mode": "default",
                            "settings": {
                                "model": "model-6.1",
                                "reasoning_effort": "high",
                                "developer_instructions": None,
                            },
                        },
                        "thread": {
                            "id": thread_id,
                            "cwd": "/workspace/test",
                            "status": {"type": "idle"},
                        },
                    }
                return {"ok": True}

        initial_resume = {
            "model": "model-5.2",
            "reasoningEffort": "low",
            "thread": {
                "id": thread_id,
                "cwd": "/workspace/test",
                "status": {"type": "active"},
                "turns": [
                    {
                        "turnId": "turn-1",
                        "status": "inProgress",
                        "model": "model-5.2",
                        "effort": "low",
                        "items": [],
                    }
                ],
            },
        }

        class MockBridge:
            registry_lock = threading.RLock()
            records = {
                "threads": {
                    thread_id: {
                        "title": "Test Chat",
                        "cwd": "/workspace/test",
                        "model": "model-5.2",
                        "effort": "low",
                        "submissions": {
                            "sub-1": {
                                "id": "sub-1",
                                "status": "queued",
                                "text": "排队消息",
                                "mode": "queue",
                            }
                        },
                    }
                }
            }
            uploads = None
            catalog_reader = None

            def _sandbox_type(self, val):
                return val

            def _adopt_record(self, tid):
                pass

            def save(self):
                pass

        bridge = MockBridge()
        chat = Chat(bridge, thread_id, initial_resume, MockBackend())

        bridge_instance = StandaloneBridge.__new__(StandaloneBridge)
        bridge_instance.records = bridge.records
        bridge_instance.registry_lock = bridge.registry_lock
        bridge_instance._adopt_record = lambda tid: None
        bridge_instance.save = lambda: None
        bridge_instance.session = lambda tid, **kw: chat
        bridge_instance.catalog = lambda tid, kind="models": {
            "models": [{"id": "model-6.1", "efforts": ["high"]}]
        }

        bridge_instance.settings(thread_id, "model-6.1", "high")

        # 正在运行的 turn 里的 model / effort 保持不变
        running_turn = chat.state["turns"][0]
        self.assertEqual(running_turn["model"], "model-5.2")
        self.assertEqual(running_turn["effort"], "low")

        # 队列中的 row 保持原样，不虚构每条 queue 的模型属性
        queued_row = chat.submissions["sub-1"]
        self.assertNotIn("model", queued_row)
        self.assertNotIn("effort", queued_row)

        # 只有 latestModel / latestReasoningEffort 变为新配置，影响下一轮
        self.assertEqual(chat.state["latestModel"], "model-6.1")
        self.assertEqual(chat.state["latestReasoningEffort"], "high")

    def test_collaboration_mode_precedence_over_top_level_model(self):
        thread_id = "collab-priority-id"

        class MockBackend:
            shared = True
            process = SimpleNamespace(poll=lambda: None)

            def request(self, method, params, timeout=30):
                if method == "thread/resume":
                    return {
                        "model": "fallback-model",
                        "reasoningEffort": "low",
                        "collaborationMode": {
                            "mode": "default",
                            "settings": {
                                "model": "priority-model-6.1",
                                "reasoning_effort": "max",
                                "developer_instructions": None,
                            },
                        },
                        "thread": {
                            "id": thread_id,
                            "cwd": "/workspace/test",
                            "status": {"type": "idle"},
                        },
                    }
                return {}

        initial_resume = {
            "model": "initial-fallback",
            "reasoningEffort": "low",
            "collaborationMode": {
                "mode": "default",
                "settings": {
                    "model": "priority-model-6.1",
                    "reasoning_effort": "max",
                },
            },
            "thread": {
                "id": thread_id,
                "cwd": "/workspace/test",
                "status": {"type": "idle"},
                "turns": [],
            },
        }

        class MockBridge:
            registry_lock = threading.RLock()
            records = {
                "threads": {
                    thread_id: {
                        "title": "Test Chat",
                        "cwd": "/workspace/test",
                        "model": "initial-fallback",
                        "effort": "low",
                        "submissions": {},
                    }
                }
            }
            uploads = None
            catalog_reader = None

            def _sandbox_type(self, val):
                return val

        bridge = MockBridge()
        chat = Chat(bridge, thread_id, initial_resume, MockBackend())

        # 初始化时 collaborationMode 优先
        self.assertEqual(chat.state["latestModel"], "priority-model-6.1")
        self.assertEqual(chat.state["latestReasoningEffort"], "max")

        # refresh_shared_state 时 collaborationMode 优先
        chat.refresh_shared_state()
        self.assertEqual(chat.state["latestModel"], "priority-model-6.1")
        self.assertEqual(chat.state["latestReasoningEffort"], "max")

    def test_backend_without_process_is_disconnected(self):
        thread_id = "no-process-id"
        class NoProcessBackend:
            shared = True
            process = None
            def request(self, method, params, timeout=30):
                return {}

        initial_resume = {
            "model": "m1", "thread": {"id": thread_id, "cwd": "/workspace/test", "status": {"type": "idle"}, "turns": []}
        }
        class MockBridge:
            registry_lock = threading.RLock()
            records = {"threads": {thread_id: {"title": "T", "cwd": "/workspace/test", "model": "m1", "submissions": {}}}}
            uploads = None
            catalog_reader = None
            def _sandbox_type(self, val): return val
            def _adopt_record(self, tid): pass
            def save(self): pass
            def catalog(self, tid, kind="models"): return {"models": [{"id": "m2", "efforts": ["low"]}]}

        chat = Chat(MockBridge(), thread_id, initial_resume, NoProcessBackend())
        # 禁止 backend 没有 process 就假活
        self.assertFalse(chat.connected)
        from bridge.features.sessions.side_chat import SideChatError
        with self.assertRaises(SideChatError):
            chat.settings("m2", "low", {"models": [{"id": "m2", "efforts": ["low"]}]})

    def test_shared_init_native_result_precedence_over_stale_entry(self):
        thread_id = "shared-init-id"
        class MockBackend:
            shared = True
            process = SimpleNamespace(poll=lambda: None)
            def request(self, method, params, timeout=30): return {}

        records = {"threads": {thread_id: {"title": "T", "cwd": "/workspace/test", "model": "model-5.6", "effort": "low", "submissions": {}}}}
        class MockBridge:
            registry_lock = threading.RLock()
            uploads = None
            catalog_reader = None
            def _sandbox_type(self, val): return val

        native_resume = {
            "model": "model-6.1",
            "reasoningEffort": "high",
            "thread": {"id": thread_id, "cwd": "/workspace/test", "status": {"type": "idle"}, "turns": []}
        }
        bridge = MockBridge()
        bridge.records = records
        chat = Chat(bridge, thread_id, native_resume, MockBackend())
        # 验证：共享模式下原生权威返回优先于旧 entry，不得启动就旧 model！
        self.assertEqual(chat.state["latestModel"], "model-6.1")
        self.assertEqual(chat.state["latestReasoningEffort"], "high")

    def test_settings_native_ack_immediately_empty_but_resume_stale_then_read_later_confirms(self):
        thread_id = "stale-then-confirm-id"
        calls = []
        resume_count = [0]

        class WSLBackend:
            shared = True
            process = SimpleNamespace(poll=lambda: None)

            def request(self, method, params, timeout=30):
                calls.append((method, copy.deepcopy(params)))
                if method == "thread/settings/update":
                    # WSL 真实环境：回 {} 只是受理，不是生效！
                    return {}
                if method == "thread/resume":
                    resume_count[0] += 1
                    # 紧接第一次 readback 仍返回旧模型 5.6
                    if resume_count[0] == 1:
                        return {
                            "model": "model-5.6",
                            "reasoningEffort": "medium",
                            "collaborationMode": {
                                "mode": "default",
                                "settings": {"model": "model-5.6", "reasoning_effort": "medium"},
                            },
                            "thread": {"id": thread_id, "cwd": "/workspace/test", "status": {"type": "idle"}},
                        }
                    # 稍后另次 readback 变为新模型 6.1
                    return {
                        "model": "model-6.1",
                        "reasoningEffort": "high",
                        "collaborationMode": {
                            "mode": "default",
                            "settings": {"model": "model-6.1", "reasoning_effort": "high"},
                        },
                        "thread": {"id": thread_id, "cwd": "/workspace/test", "status": {"type": "idle"}},
                    }
                return {}

        initial_resume = {
            "model": "model-5.6",
            "reasoningEffort": "medium",
            "thread": {"id": thread_id, "cwd": "/workspace/test", "status": {"type": "idle"}, "turns": []},
        }

        class MockBridge:
            registry_lock = threading.RLock()
            records = {"threads": {thread_id: {"title": "T", "cwd": "/workspace/test", "model": "model-5.6", "effort": "medium", "submissions": {}}}}
            uploads = None
            catalog_reader = None
            def _sandbox_type(self, val): return val
            def save(self): pass

        backend = WSLBackend()
        chat = Chat(MockBridge(), thread_id, initial_resume, backend)
        result = chat.settings("model-6.1", "high", {"models": [{"id": "model-6.1", "efforts": ["high"]}]}, timeout=5.0)
        self.assertEqual(result["model"], "model-6.1")
        self.assertEqual(chat.state["latestModel"], "model-6.1")
        self.assertEqual(chat.state["latestReasoningEffort"], "high")
        self.assertGreaterEqual(resume_count[0], 2)

    def test_settings_forever_stale_fails_without_fake_success(self):
        thread_id = "forever-stale-id"

        class ForeverStaleBackend:
            shared = True
            process = SimpleNamespace(poll=lambda: None)

            def request(self, method, params, timeout=30):
                if method == "thread/settings/update":
                    return {}
                if method == "thread/resume":
                    return {
                        "model": "model-5.6",
                        "reasoningEffort": "medium",
                        "collaborationMode": {
                            "mode": "default",
                            "settings": {"model": "model-5.6", "reasoning_effort": "medium"},
                        },
                        "thread": {"id": thread_id, "cwd": "/workspace/test", "status": {"type": "idle"}},
                    }
                return {}

        initial_resume = {
            "model": "model-5.6",
            "reasoningEffort": "medium",
            "thread": {"id": thread_id, "cwd": "/workspace/test", "status": {"type": "idle"}, "turns": []},
        }

        class MockBridge:
            registry_lock = threading.RLock()
            records = {"threads": {thread_id: {"title": "T", "cwd": "/workspace/test", "model": "model-5.6", "effort": "medium", "submissions": {}}}}
            uploads = None
            catalog_reader = None
            def _sandbox_type(self, val): return val
            def save(self): pass

        chat = Chat(MockBridge(), thread_id, initial_resume, ForeverStaleBackend())
        from bridge.features.sessions.side_chat import SideChatError
        with self.assertRaises(SideChatError) as ctx:
            chat.settings("model-6.1", "high", {"models": [{"id": "model-6.1", "efforts": ["high"]}]}, timeout=0.3)
        self.assertIn("未能在时限内确认生效", str(ctx.exception))
        self.assertEqual(chat.state["latestModel"], "model-5.6")
        self.assertEqual(chat.state["latestReasoningEffort"], "medium")

    def test_settings_unknown_error_fails(self):
        thread_id = "unknown-err-id"

        class UnknownErrBackend:
            shared = True
            process = SimpleNamespace(poll=lambda: None)

            def request(self, method, params, timeout=30):
                if method == "thread/settings/update":
                    raise ConnectionResetError("网络异常，无法连接")
                return {}

        initial_resume = {
            "model": "model-5.6",
            "reasoningEffort": "medium",
            "thread": {"id": thread_id, "cwd": "/workspace/test", "status": {"type": "idle"}, "turns": []},
        }

        class MockBridge:
            registry_lock = threading.RLock()
            records = {"threads": {thread_id: {"title": "T", "cwd": "/workspace/test", "model": "model-5.6", "effort": "medium", "submissions": {}}}}
            uploads = None
            catalog_reader = None
            def _sandbox_type(self, val): return val
            def save(self): pass

        chat = Chat(MockBridge(), thread_id, initial_resume, UnknownErrBackend())
        with self.assertRaises(ConnectionResetError):
            chat.settings("model-6.1", "high", {"models": [{"id": "model-6.1", "efforts": ["high"]}]})
        self.assertEqual(chat.state["latestModel"], "model-5.6")

    def test_settings_same_value_update_confirms_immediately_without_waiting_for_events(self):
        thread_id = "same-value-thread-id"
        calls = []

        class SameValueBackend:
            shared = True
            process = SimpleNamespace(poll=lambda: None)

            def request(self, method, params, timeout=30):
                calls.append((method, copy.deepcopy(params)))
                if method == "thread/settings/update":
                    return {}
                if method == "thread/resume":
                    return {
                        "model": "model-6.1",
                        "reasoningEffort": "high",
                        "collaborationMode": {
                            "mode": "default",
                            "settings": {"model": "model-6.1", "reasoning_effort": "high"},
                        },
                        "thread": {"id": thread_id, "cwd": "/workspace/test", "status": {"type": "idle"}},
                    }
                return {}

        initial_resume = {
            "model": "model-6.1",
            "reasoningEffort": "high",
            "thread": {"id": thread_id, "cwd": "/workspace/test", "status": {"type": "idle"}, "turns": []},
        }

        class MockBridge:
            registry_lock = threading.RLock()
            records = {"threads": {thread_id: {"title": "T", "cwd": "/workspace/test", "model": "model-6.1", "effort": "high", "submissions": {}}}}
            uploads = None
            catalog_reader = None
            def _sandbox_type(self, val): return val
            def save(self): pass

        backend = SameValueBackend()
        chat = Chat(MockBridge(), thread_id, initial_resume, backend)
        result = chat.settings("model-6.1", "high", {"models": [{"id": "model-6.1", "efforts": ["high"]}]}, timeout=5.0)
        self.assertEqual(result["model"], "model-6.1")
        # 只要一次 resume 即可确认，绝不需要等待 thread/settings/updated 事件
        resume_calls = [c for c in calls if c[0] == "thread/resume"]
        self.assertEqual(len(resume_calls), 1)

    def test_settings_without_collaboration_mode_confirms_top_level(self):
        thread_id = "no-collab-thread-id"

        class NoCollabBackend:
            shared = False
            process = SimpleNamespace(poll=lambda: None)

            def request(self, method, params, timeout=30):
                if method == "thread/settings/update":
                    return {}
                if method == "thread/resume":
                    # 原生返回只在顶层提供 model 和 reasoningEffort，无 collaborationMode
                    return {
                        "model": "model-6.1",
                        "reasoningEffort": "low",
                        "collaborationMode": None,
                        "thread": {"id": thread_id, "cwd": "/workspace/test", "status": {"type": "idle"}},
                    }
                return {}

        initial_resume = {
            "model": "model-5.2",
            "reasoningEffort": "low",
            "thread": {"id": thread_id, "cwd": "/workspace/test", "status": {"type": "idle"}, "turns": []},
        }

        class MockBridge:
            registry_lock = threading.RLock()
            records = {"threads": {thread_id: {"title": "T", "cwd": "/workspace/test", "model": "model-5.2", "effort": "low", "submissions": {}}}}
            uploads = None
            catalog_reader = None
            def _sandbox_type(self, val): return val
            def save(self): pass

        chat = Chat(MockBridge(), thread_id, initial_resume, NoCollabBackend())
        result = chat.settings("model-6.1", "low", {"models": [{"id": "model-6.1", "efforts": ["low"]}]}, timeout=5.0)
        self.assertEqual(result["model"], "model-6.1")
        self.assertEqual(chat.state["latestModel"], "model-6.1")


if __name__ == "__main__":
    unittest.main()
