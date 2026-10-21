"""Tests for Codex project scopes, git workspace detection and worktree isolation."""

import os
import shutil
import tempfile
import unittest
from pathlib import Path

from bridge.features.workspace.project_scopes import (
    browse_scoped_directories,
    create_scoped_worktree,
    get_scoped_worktree_info,
    remove_scoped_worktree,
    resolve_scoped_cwd,
    run_git_command,
)


class ProjectScopesTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp(prefix="codex-scopes-test-")
        self.ws_root = Path(self.temp_dir).resolve()
        self.workspaces = [
            {"key": "local|test", "name": "TestWS", "path": str(self.ws_root)}
        ]

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_resolve_scoped_cwd_valid(self):
        sub = self.ws_root / "subdir"
        sub.mkdir()
        ws, resolved = resolve_scoped_cwd(str(sub), self.workspaces, must_exist=True)
        self.assertEqual(ws["key"], "local|test")
        self.assertEqual(resolved, sub)

    def test_resolve_scoped_cwd_outside_fails_closed(self):
        outside = Path(tempfile.gettempdir()).resolve()
        with self.assertRaises(PermissionError):
            resolve_scoped_cwd(str(outside), self.workspaces, must_exist=True)

    def test_resolve_scoped_cwd_traversal_fails_closed(self):
        traversal = str(self.ws_root) + "/../../etc"
        with self.assertRaises(PermissionError):
            resolve_scoped_cwd(traversal, self.workspaces, must_exist=False)

    def test_resolve_scoped_cwd_symlink_escape_fails_closed(self):
        outside = Path(tempfile.gettempdir()).resolve()
        symlink_dir = self.ws_root / "escape_link"
        try:
            os.symlink(str(outside), str(symlink_dir))
        except OSError:
            self.skipTest("Symlinks not supported in environment")
        with self.assertRaises(PermissionError):
            resolve_scoped_cwd(str(symlink_dir), self.workspaces, must_exist=True)

    def test_non_git_directory_selection_disables_worktree(self):
        sub = self.ws_root / "plain_folder"
        sub.mkdir()
        ws, resolved = resolve_scoped_cwd(str(sub), self.workspaces, must_exist=True)
        info = get_scoped_worktree_info(resolved, ws)
        self.assertFalse(info["isGit"])
        self.assertEqual(info["projectRoot"], str(self.ws_root))
        self.assertEqual(info["worktrees"], [])

    def test_git_repo_and_subdir_root_resolution(self):
        repo = self.ws_root / "myrepo"
        repo.mkdir()
        run_git_command(repo, ["init"])
        run_git_command(repo, ["config", "user.email", "test@example.com"])
        run_git_command(repo, ["config", "user.name", "Tester"])
        (repo / "README.md").write_text("hello")
        run_git_command(repo, ["add", "README.md"])
        run_git_command(repo, ["commit", "-m", "init"])

        subdir = repo / "sub" / "deep"
        subdir.mkdir(parents=True)

        ws, resolved = resolve_scoped_cwd(str(subdir), self.workspaces, must_exist=True)
        info = get_scoped_worktree_info(resolved, ws)
        self.assertTrue(info["isGit"])
        self.assertEqual(info["projectRoot"], str(repo))
        self.assertFalse(info["isTopLevel"])
        self.assertEqual(len(info["worktrees"]), 1)
        self.assertTrue(info["worktrees"][0]["isMain"])

    def test_create_worktree_and_list_lifecycle(self):
        repo = self.ws_root / "repo2"
        repo.mkdir()
        run_git_command(repo, ["init"])
        run_git_command(repo, ["config", "user.email", "test@example.com"])
        run_git_command(repo, ["config", "user.name", "Tester"])
        (repo / "file.txt").write_text("v1")
        run_git_command(repo, ["add", "file.txt"])
        run_git_command(repo, ["commit", "-m", "initial"])

        ws, resolved = resolve_scoped_cwd(str(repo), self.workspaces, must_exist=True)
        # Create worktree
        result = create_scoped_worktree(resolved, "feat/issue-1", ws)
        self.assertEqual(result["branch"], "feat/issue-1")
        wt_path = Path(result["path"])
        self.assertTrue(wt_path.exists())
        self.assertTrue(wt_path.is_relative_to(self.ws_root))

        # Inspect updated worktrees
        info = get_scoped_worktree_info(resolved, ws)
        self.assertEqual(len(info["worktrees"]), 2)
        branches = [wt["branch"] for wt in info["worktrees"]]
        self.assertIn("feat/issue-1", branches)

        # Attempting duplicate checkout should fail
        with self.assertRaises(ValueError):
            create_scoped_worktree(resolved, "feat/issue-1", ws)

    def test_invalid_branch_name_rejected(self):
        repo = self.ws_root / "repo3"
        repo.mkdir()
        run_git_command(repo, ["init"])
        ws, resolved = resolve_scoped_cwd(str(repo), self.workspaces, must_exist=True)
        with self.assertRaises(ValueError):
            create_scoped_worktree(resolved, "--bad-flag", ws)
        with self.assertRaises(ValueError):
            create_scoped_worktree(resolved, "feat;rm -rf /", ws)

    def test_codex_delete_worktree_forbidden(self):
        with self.assertRaises(PermissionError):
            remove_scoped_worktree(self.ws_root, "/some/path")

    def test_main_subdir_linked_share_stable_root_and_is_main_flag(self):
        repo = self.ws_root / "stable_root_repo"
        repo.mkdir()
        run_git_command(repo, ["init"])
        run_git_command(repo, ["config", "user.email", "test@example.com"])
        run_git_command(repo, ["config", "user.name", "Tester"])
        (repo / "file.txt").write_text("v1")
        run_git_command(repo, ["add", "file.txt"])
        run_git_command(repo, ["commit", "-m", "init"])

        ws, resolved_main = resolve_scoped_cwd(str(repo), self.workspaces, must_exist=True)
        # Create a linked worktree
        wt_result = create_scoped_worktree(resolved_main, "feat/stable-1", ws)
        linked_path = Path(wt_result["path"])
        linked_sub = linked_path / "subfolder"
        linked_sub.mkdir()
        main_sub = repo / "main_sub"
        main_sub.mkdir()

        # Check from main root
        info_main = get_scoped_worktree_info(resolved_main, ws)
        # Check from main subdir
        ws, resolved_main_sub = resolve_scoped_cwd(str(main_sub), self.workspaces, must_exist=True)
        info_main_sub = get_scoped_worktree_info(resolved_main_sub, ws)
        # Check from linked root
        ws, resolved_linked = resolve_scoped_cwd(str(linked_path), self.workspaces, must_exist=True)
        info_linked = get_scoped_worktree_info(resolved_linked, ws)
        # Check from linked subdir
        ws, resolved_linked_sub = resolve_scoped_cwd(str(linked_sub), self.workspaces, must_exist=True)
        info_linked_sub = get_scoped_worktree_info(resolved_linked_sub, ws)

        expected_root = str(repo)
        expected_key = f"codex:{repo}"

        for name, info in [
            ("main", info_main),
            ("main_sub", info_main_sub),
            ("linked", info_linked),
            ("linked_sub", info_linked_sub),
        ]:
            self.assertTrue(info["isGit"], f"{name} should be git")
            self.assertEqual(info["projectRoot"], expected_root, f"{name} projectRoot must be main root")
            self.assertEqual(info["projectKey"], expected_key, f"{name} projectKey must be stable")
            # Only records[0] is main
            self.assertEqual(len(info["worktrees"]), 2)
            main_wts = [w for w in info["worktrees"] if w["isMain"]]
            self.assertEqual(len(main_wts), 1, f"{name} must have exactly one isMain worktree")
            self.assertEqual(main_wts[0]["path"], str(repo))
            linked_wts = [w for w in info["worktrees"] if not w["isMain"]]
            self.assertEqual(len(linked_wts), 1)
            self.assertEqual(linked_wts[0]["path"], str(linked_path))

        # Check isTopLevel precision
        self.assertTrue(info_main["isTopLevel"])
        self.assertFalse(info_main_sub["isTopLevel"])
        self.assertTrue(info_linked["isTopLevel"])
        self.assertFalse(info_linked_sub["isTopLevel"])

    def test_worktree_escaping_workspace_fails_closed(self):
        repo = self.ws_root / "repo_escape"
        repo.mkdir()
        run_git_command(repo, ["init"])
        run_git_command(repo, ["config", "user.email", "test@example.com"])
        run_git_command(repo, ["config", "user.name", "Tester"])
        (repo / "file.txt").write_text("v1")
        run_git_command(repo, ["add", "file.txt"])
        run_git_command(repo, ["commit", "-m", "init"])

        # Add a worktree pointing outside ws_root directly via git
        outside_dir = Path(tempfile.gettempdir()) / f"outside_wt_{os.getpid()}"
        try:
            run_git_command(repo, ["worktree", "add", "-b", "outside-branch", str(outside_dir)])
            ws, resolved = resolve_scoped_cwd(str(repo), self.workspaces, must_exist=True)
            with self.assertRaises(PermissionError):
                get_scoped_worktree_info(resolved, ws)
        finally:
            shutil.rmtree(outside_dir, ignore_errors=True)

    def test_browse_directories(self):
        (self.ws_root / "dir1").mkdir()
        (self.ws_root / "dir2").mkdir()
        (self.ws_root / ".hidden").mkdir()
        (self.ws_root / "file.txt").write_text("content")

        res = browse_scoped_directories(self.ws_root, self.workspaces[0])
        self.assertEqual(res["path"], str(self.ws_root))
        self.assertEqual(res["parentPath"], "/")
        names = [d["name"] for d in res["directories"]]
        self.assertEqual(names, ["dir1", "dir2"])


if __name__ == "__main__":
    unittest.main()
