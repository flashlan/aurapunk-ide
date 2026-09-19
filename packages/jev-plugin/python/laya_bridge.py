#!/usr/bin/env python3
"""
Python bridge for Laya (convaiinnovations/laya)
Enables local ModernBERT-large System 1 non-autoregressive decision inference.
Usage:
    python3 laya_bridge.py < input.json
    or stdin JSON RPC: {"state": "...", "questions": {...}}
"""

import sys
import json

def main():
    try:
        raw_input = sys.stdin.read().strip()
        if not raw_input:
            print(json.dumps({"error": "Empty input"}))
            sys.exit(1)

        payload = json.loads(raw_input)
        state = payload.get("state", "")
        questions = payload.get("questions", {})

        # Try to import official laya package
        try:
            import laya
            agent = laya.load("convaiinnovations/laya")
            result = agent.predict(state, questions)
            print(json.dumps({"answers": result.get("answers", {}), "engine": "laya-hf"}))
            sys.exit(0)
        except ImportError:
            # Fallback simulator if laya package is not installed in current python environment
            answers = {}
            for q_id, q_data in questions.items():
                q_type = q_data.get("type", "noul")
                if q_type == "noul":
                    answers[q_id] = {"type": "noul", "probability": 0.82, "verdict": True}
                elif q_type == "choice":
                    criteria = q_data.get("criteria", {})
                    first_key = list(criteria.keys())[0] if criteria else "default"
                    answers[q_id] = {"type": "choice", "choice": first_key, "confidence": 0.88, "probabilities": {first_key: 0.88}}
                elif q_type == "score":
                    answers[q_id] = {"type": "score", "score": 1.0, "levelIndex": 1, "levelLabel": "normal", "confidence": 0.85}
            
            print(json.dumps({
                "answers": answers,
                "engine": "laya-bridge-simulated",
                "notice": "Install 'laya' via 'pip install laya' for full Hugging Face weights."
            }))
            sys.exit(0)

    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
