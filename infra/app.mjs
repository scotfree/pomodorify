// Pomodorify hosting: private S3 bucket behind CloudFront, served at https://pomodorifi.es.
// Deploy with: npm run deploy   (always uses the `personal` AWS profile)
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as iam from 'aws-cdk-lib/aws-iam';

// Pinned so a deploy with the wrong profile fails instead of creating resources elsewhere.
const ACCOUNT = '280439772481';
// us-east-1 because CloudFront only accepts ACM certificates from that region.
const REGION = 'us-east-1';

const DOMAIN = 'pomodorifi.es';
const HOSTED_ZONE_ID = 'Z1SJVITDAO70U6';
const GITHUB_REPO = 'scotfree/pomodorify';

class PomodorifyStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);

        const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
            hostedZoneId: HOSTED_ZONE_ID,
            zoneName: DOMAIN,
        });

        const bucket = new s3.Bucket(this, 'SiteBucket', {
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
        });

        const certificate = new acm.Certificate(this, 'Certificate', {
            domainName: DOMAIN,
            validation: acm.CertificateValidation.fromDns(zone),
        });

        const distribution = new cloudfront.Distribution(this, 'Distribution', {
            defaultBehavior: {
                origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            },
            defaultRootObject: 'index.html',
            domainNames: [DOMAIN],
            certificate,
            priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
        });

        // The pre-existing A record (pointing at the old EC2 box) must be deleted by hand before
        // the first deploy, or CloudFormation will refuse to create this one.
        const aliasTarget = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution));
        new route53.ARecord(this, 'AliasA', { zone, target: aliasTarget });
        new route53.AaaaRecord(this, 'AliasAAAA', { zone, target: aliasTarget });

        // GitHub Actions assumes this role via OIDC; only pushes to main in this repo can use it.
        const githubOidc = new iam.OidcProviderNative(this, 'GitHubOidc', {
            url: 'https://token.actions.githubusercontent.com',
            clientIds: ['sts.amazonaws.com'],
        });

        const deployRole = new iam.Role(this, 'DeployRole', {
            assumedBy: new iam.WebIdentityPrincipal(githubOidc.oidcProviderArn, {
                StringEquals: {
                    'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                    'token.actions.githubusercontent.com:sub': `repo:${GITHUB_REPO}:ref:refs/heads/main`,
                },
            }),
            maxSessionDuration: cdk.Duration.hours(1),
        });
        bucket.grantReadWrite(deployRole);
        distribution.grantCreateInvalidation(deployRole);

        new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });
        new cdk.CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
        new cdk.CfnOutput(this, 'DistributionDomain', { value: distribution.distributionDomainName });
        new cdk.CfnOutput(this, 'DeployRoleArn', { value: deployRole.roleArn });
    }
}

const app = new cdk.App();
new PomodorifyStack(app, 'Pomodorify', { env: { account: ACCOUNT, region: REGION } });
