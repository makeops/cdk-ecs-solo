import { awscdk, javascript } from 'projen';
const project = new awscdk.AwsCdkConstructLibrary({
  author: 'Jason Forte (MakeOps)',
  authorAddress: 'https://www.makeops.com',
  authorOrganization: true,
  authorName: 'MakeOps',
  cdkVersion: '2.265.0',
  jsiiVersion: '~6.0.0',
  license: 'Apache-2.0',
  name: '@makeops/cdk-ecs-solo',
  packageManager: javascript.NodePackageManager.PNPM,
  pnpmVersion: '11.21.0',

  projenrcTs: true,
  repositoryUrl: 'https://github.com/makeops/cdk-ecs-solo',
  homepage: 'https://github.com/makeops/cdk-ecs-solo',

  description: 'A CDK construct to deploy an app to a single EC2 instance using ECS',

  keywords: ['awscdk', 'cdk', 'ecs'],

  typescriptVersion: '~5.8.2',

  npmAccess: javascript.NpmAccess.PUBLIC,

  gitignore: [
    '_infra/',
    '.cursor/',
  ],

  majorVersion: 0,

  pnpmOptions: {
    workspaceYamlOptions: {
      allowBuilds: {
        'unrs-resolver': true,
        '@swc/core': true,
        'esbuild': true,
      },
    },
  },

  // defaultReleaseBranch: "main",  /* The name of the main release branch. */
  // deps: [],                      /* Runtime dependencies of this module. */
  // description: undefined,        /* The description is just a string that helps people understand the purpose of the package. */
  // devDeps: [],                   /* Build dependencies for this module. */
  // packageName: undefined,        /* The "name" in package.json. */
});
project.synth();
