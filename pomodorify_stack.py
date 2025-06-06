from aws_cdk import (
    Stack,
    aws_lambda as _lambda,
    aws_apigateway as apigw,
    aws_iam as iam,
    aws_logs as logs,
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
                "SPOTIFY_CLIENT_ID_PARAM": "/pomodorify/dev/SPOTIFY_CLIENT_ID",
                "SPOTIFY_CLIENT_SECRET_PARAM": "/pomodorify/dev/SPOTIFY_CLIENT_SECRET",
                "SPOTIFY_REDIRECT_URI_PARAM": "/pomodorify/dev/SPOTIFY_REDIRECT_URI",
            },
            log_retention=logs.RetentionDays.ONE_WEEK,
            tracing=_lambda.Tracing.ACTIVE
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

        # Grant Lambda permissions for CloudWatch Logs
        lambda_function.add_to_role_policy(
            iam.PolicyStatement(
                actions=[
                    "logs:CreateLogGroup",
                    "logs:CreateLogStream",
                    "logs:PutLogEvents"
                ],
                resources=[
                    f"arn:aws:logs:{self.region}:*:log-group:/aws/lambda/*"
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
            ),
            cloud_watch_role=True,
            deploy_options=apigw.StageOptions(
                logging_level=apigw.MethodLoggingLevel.INFO,
                data_trace_enabled=True,
                access_log_destination=apigw.LogGroupLogDestination(
                    logs.LogGroup(
                        self, "ApiGatewayAccessLogs",
                        log_group_name=f"/aws/apigateway/{self.stack_name}/access-logs",
                        retention=logs.RetentionDays.ONE_WEEK
                    )
                )
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