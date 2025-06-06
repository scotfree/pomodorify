from aws_cdk import (
    Stack,
    aws_lambda as _lambda,
    aws_apigateway as apigw,
    aws_iam as iam,
    aws_ssm as ssm,
)
from constructs import Construct

class PomodorifyStack(Stack):
    def __init__(self, scope: Construct, construct_id: str, **kwargs) -> None:
        super().__init__(scope, construct_id, **kwargs)

        # Create Lambda function
        lambda_function = _lambda.Function(
            self, "PomodorifyFunction",
            runtime=_lambda.Runtime.PYTHON_3_9,
            code=_lambda.Code.from_asset("backend"),
            handler="wsgi_handler.handler",
            environment={
                "SPOTIFY_CLIENT_ID": ssm.StringParameter.value_for_string_parameter(
                    self, "/pomodorify/dev/SPOTIFY_CLIENT_ID"
                ),
                "SPOTIFY_CLIENT_SECRET": ssm.StringParameter.value_for_string_parameter(
                    self, "/pomodorify/dev/SPOTIFY_CLIENT_SECRET"
                ),
                "SPOTIFY_REDIRECT_URI": ssm.StringParameter.value_for_string_parameter(
                    self, "/pomodorify/dev/SPOTIFY_REDIRECT_URI"
                ),
            }
        )

        # Grant Lambda permissions to access SSM parameters
        lambda_function.add_to_role_policy(
            iam.PolicyStatement(
                actions=[
                    "ssm:GetParameter",
                    "ssm:GetParameters",
                    "ssm:GetParametersByPath"
                ],
                resources=[
                    f"arn:aws:ssm:{self.region}:*:parameter/pomodorify/dev/*"
                ]
            )
        )

        # Create API Gateway
        api = apigw.RestApi(
            self, "PomodorifyApi",
            rest_api_name="Pomodorify API",
            description="API for Pomodorify application",
            default_cors_preflight_options=apigw.CorsOptions(
                allow_origins=apigw.Cors.ALL_ORIGINS,
                allow_methods=apigw.Cors.ALL_METHODS
            )
        )

        # Create Lambda integration
        integration = apigw.LambdaIntegration(
            lambda_function,
            request_templates={"application/json": '{ "statusCode": "200" }'}
        )

        # Add proxy resource
        api.root.add_proxy(
            default_integration=integration,
            any_method=True
        ) 