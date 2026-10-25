from pathlib import Path

import yaml
from conftest import make_config

from tolktak.livekit_process import livekit_config

COMPOSE = Path(__file__).parents[2] / "deploy" / "compose.yaml"


def test_compose_livekit_matches_embedded(tmp_path):
    compose = yaml.safe_load(COMPOSE.read_text())
    livekit = yaml.safe_load(compose["services"]["livekit"]["environment"]["LIVEKIT_CONFIG"])
    embedded = livekit_config(make_config(tmp_path))
    assert livekit["room"] == embedded["room"]
    assert livekit["turn"] == embedded["turn"]
