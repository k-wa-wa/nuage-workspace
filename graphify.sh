#!/bin/bash

set -e

~/.local/bin/graphify extract ../ --code-only
~/.local/bin/graphify cluster-only ../

mv ../graphify-out ./
