#!/usr/bin/env python3
import json, os, subprocess, tempfile, zipfile, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.join(HERE, '..', 'skills', 'xmind', 'scripts')


def make_modern_xmind(path):
    content = [{
        "id": "sheet-1",
        "title": "S1",
        "rootTopic": {
            "id": "root-1",
            "title": "中心主题",
            "children": {"attached": [
                {"id": "a-1", "title": "一级节点", "children": {"attached": [{"id": "b-1", "title": "二级节点"}]}},
                {"id": "a-2", "title": "一级节点", "children": {"attached": [{"id": "b-2", "title": "二级节点"}]}}
            ]}
        }
    }]
    with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED) as z:
        z.writestr('content.json', json.dumps(content))
        z.writestr('metadata.json', '{}')
        z.writestr('manifest.json', '{"file-entries":{}}')


def run_edit(args):
    return subprocess.run(['node', os.path.join(SCRIPTS, 'edit_xmind.mjs')] + args, capture_output=True, text=True)


def read_content(path):
    with zipfile.ZipFile(path, 'r') as z:
        return json.loads(z.read('content.json'))


def main():
    with tempfile.TemporaryDirectory() as d:
        inp = os.path.join(d, 'in.xmind')
        outp = os.path.join(d, 'out.xmind')
        make_modern_xmind(inp)

        ops = os.path.join(d, 'ops.json')
        json.dump([{"op":"rename","target":{"id":"b-1"},"title":"改名1"}], open(ops, 'w'))
        r = run_edit(['--input', inp, '--output', outp, '--ops', ops])
        assert r.returncode == 0, r.stderr
        assert read_content(outp)[0]['rootTopic']['children']['attached'][0]['children']['attached'][0]['title'] == '改名1'

        out2 = os.path.join(d, 'out2.xmind')
        json.dump([{"op":"rename","target":{"path":["中心主题","一级节点","二级节点"]},"title":"P改名"}], open(ops, 'w'))
        r = run_edit(['--input', inp, '--output', out2, '--ops', ops])
        assert r.returncode != 0 and 'multiple topics' in r.stderr

        out3 = os.path.join(d, 'out3.xmind')
        json.dump([{"op":"append_children","target":{"id":"a-1"},"children":[{"title":"C1"},{"title":"C2","children":[{"title":"GC"}]}]}], open(ops, 'w'))
        r = run_edit(['--input', inp, '--output', out3, '--ops', ops])
        assert r.returncode == 0, r.stderr
        ch = read_content(out3)[0]['rootTopic']['children']['attached'][0]['children']['attached']
        assert ch[-2]['title'] == 'C1' and ch[-1]['title'] == 'C2' and ch[-1]['children']['attached'][0]['title'] == 'GC'
        ids = set()
        def walk(t):
            assert t['id'] not in ids
            ids.add(t['id'])
            for x in (t.get('children', {}).get('attached', [])): walk(x)
        walk(read_content(out3)[0]['rootTopic'])

        json.dump([{"op":"rename","target":{"id":"not-found"},"title":"X"}], open(ops, 'w'))
        r = run_edit(['--input', inp, '--output', os.path.join(d,'bad.xmind'), '--ops', ops])
        assert r.returncode != 0 and 'not found' in r.stderr

        dry = run_edit(['--input', inp, '--ops', ops, '--dry-run'])
        assert dry.returncode != 0

    print('PASS test_edit_xmind')


if __name__ == '__main__':
    main()
