"""Create (or reuse) the Agent Platform runtime that backs MissionLock Sessions and Memory Bank.

The runtime is a lightweight, code-less Agent Runtime: Cloud Run hosts the ADK agents, and this
instance only provides managed Sessions + Memory Bank. Everything bills to Vertex AI
(aiplatform.googleapis.com) on project tesselle-demandfoundry.

    python tools/provision_agent_platform.py            # prints the runtime id
"""

import argparse
import sys

import agentplatform

PROJECT = "tesselle-demandfoundry"
LOCATION = "asia-southeast1"
DISPLAY_NAME = "tesselle-missionlock"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--location", default=LOCATION)
    parser.add_argument("--generation-model", default="gemini-3.5-flash")  # regional model in asia-southeast1
    parser.add_argument("--embedding-model", default="gemini-embedding-001")  # regional model in asia-southeast1
    args = parser.parse_args()

    client = agentplatform.Client(project=PROJECT, location=args.location)
    base = f"projects/{PROJECT}/locations/{args.location}/publishers/google/models"
    memory_bank_config = {
        "generation_config": {"model": f"{base}/{args.generation_model}"},
        "similarity_search_config": {"embedding_model": f"{base}/{args.embedding_model}"},
    }
    for runtime in client.runtimes.list():
        resource = runtime.api_resource
        if resource.display_name == DISPLAY_NAME:
            # Keep the Memory Bank models in sync (they must be served in the runtime's region).
            client.runtimes.update(name=resource.name, config={"context_spec": {"memory_bank_config": memory_bank_config}})
            print(f"updated {resource.name}")
            print(resource.name.split("/")[-1])
            return

    runtime = client.runtimes.create(
        config={
            "display_name": DISPLAY_NAME,
            "description": "Sessions + Memory Bank for DemandFoundry MissionLock (Project Tesselle)",
            "labels": {"app": "tesselle"},
            "context_spec": {"memory_bank_config": memory_bank_config},
        }
    )
    name = runtime.api_resource.name
    print(f"created {name}")
    print(name.split("/")[-1])


if __name__ == "__main__":
    sys.exit(main())
