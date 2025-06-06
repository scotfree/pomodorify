#!/usr/bin/env python3
import os
from aws_cdk import App, Environment
from pomodorify_stack import PomodorifyStack

app = App()
PomodorifyStack(app, "PomodorifyStack",
    env=Environment(
        account=os.getenv('CDK_DEFAULT_ACCOUNT'),
        region=os.getenv('CDK_DEFAULT_REGION', 'us-west-1')
    )
)

app.synth() 