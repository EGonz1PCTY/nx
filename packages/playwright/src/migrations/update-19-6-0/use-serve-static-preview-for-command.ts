import {
  CreateNodesV2,
  createProjectGraphAsync,
  formatFiles,
  getPackageManagerCommand,
  joinPathFragments,
  parseTargetString,
  readNxJson,
  type Tree,
  visitNotIgnoredFiles,
} from '@nx/devkit';
import { tsquery } from '@phenomnomnominal/tsquery';
import addE2eCiTargetDefaults from './add-e2e-ci-target-defaults';
import type { ConfigurationResult } from 'nx/src/project-graph/utils/project-configuration-utils';
import { LoadedNxPlugin } from 'nx/src/project-graph/plugins/internal-api';
import { retrieveProjectConfigurations } from 'nx/src/project-graph/utils/retrieve-workspace-files';
import { ProjectConfigurationsError } from 'nx/src/project-graph/error-types';
import {
  WebpackPluginOptions,
  createNodesV2 as webpackCreateNodesV2,
} from '@nx/webpack/src/plugins/plugin';
import {
  VitePluginOptions,
  createNodesV2 as viteCreateNodesV2,
} from '@nx/vite/plugin';
import type { Node } from 'typescript';

export default async function (tree: Tree) {
  const graph = await createProjectGraphAsync();

  const collectedProjects: {
    projectName: string;
    configFile: string;
    configFileType: 'webpack' | 'vite';
    playwrightConfigFile: string;
    commandValueNode: Node;
  }[] = [];
  visitNotIgnoredFiles(tree, '', async (path) => {
    if (!path.endsWith('playwright.config.ts')) {
      return;
    }

    let playwrightConfigFileContents = tree.read(path, 'utf-8');

    const WEBSERVER_COMMAND_SELECTOR =
      'PropertyAssignment:has(Identifier[name=webServer]) PropertyAssignment:has(Identifier[name=command]) > StringLiteral';
    let ast = tsquery.ast(playwrightConfigFileContents);
    const nodes = tsquery(ast, WEBSERVER_COMMAND_SELECTOR, {
      visitAllChildren: true,
    });
    if (!nodes.length) {
      return;
    }

    const commandValueNode = nodes[0];
    const command = commandValueNode.getText();
    let project: string;
    if (command.includes('nx run')) {
      const NX_RUN_TARGET_REGEX = "(?<=nx run )[^']+";
      const matches = command.match(NX_RUN_TARGET_REGEX);
      if (!matches) {
        return;
      }
      const targetString = matches[0];
      const parsedTargetString = parseTargetString(targetString, graph);

      if (
        parsedTargetString.target === 'serve-static' ||
        parsedTargetString.target === 'preview'
      ) {
        return;
      }

      project = parsedTargetString.project;
    } else {
      const NX_PROJECT_REGEX = "(?<=nx [^ ]+ )[^']+";
      const matches = command.match(NX_PROJECT_REGEX);
      if (!matches) {
        return;
      }
      project = matches[0];
    }

    const pathToViteConfig = [
      joinPathFragments(graph.nodes[project].data.root, 'vite.config.ts'),
      joinPathFragments(graph.nodes[project].data.root, 'vite.config.js'),
    ].find((p) => tree.exists(p));

    const pathToWebpackConfig = [
      joinPathFragments(graph.nodes[project].data.root, 'webpack.config.ts'),
      joinPathFragments(graph.nodes[project].data.root, 'webpack.config.js'),
    ].find((p) => tree.exists(p));

    collectedProjects.push({
      projectName: project,
      configFile: pathToWebpackConfig ?? pathToViteConfig,
      configFileType: pathToWebpackConfig ? 'webpack' : 'vite',
      playwrightConfigFile: path,
      commandValueNode,
    });
  });

  for (const projectToMigrate of collectedProjects) {
    let playwrightConfigFileContents = tree.read(
      projectToMigrate.playwrightConfigFile,
      'utf-8'
    );
    const targetName = await getServeStaticTargetNameForConfigFile(
      tree,
      projectToMigrate.configFileType === 'webpack'
        ? '@nx/webpack/plugin'
        : '@nx/vite/plugin',
      projectToMigrate.configFile,
      projectToMigrate.configFileType === 'webpack'
        ? 'serve-static'
        : 'preview',
      projectToMigrate.configFileType === 'webpack'
        ? 'serveStaticTargetName'
        : 'previewTargetName',
      projectToMigrate.configFileType === 'webpack'
        ? webpackCreateNodesV2
        : viteCreateNodesV2
    );
    const oldCommand = projectToMigrate.commandValueNode.getText();
    const newCommand = oldCommand.replace(
      /nx.*[^"']/,
      `nx run ${projectToMigrate.projectName}:${targetName}`
    );
    if (projectToMigrate.configFileType === 'webpack') {
      tree.write(
        projectToMigrate.playwrightConfigFile,
        `${playwrightConfigFileContents.slice(
          0,
          projectToMigrate.commandValueNode.getStart()
        )}${newCommand}${playwrightConfigFileContents.slice(
          projectToMigrate.commandValueNode.getEnd()
        )}`
      );
    } else {
      tree.write(
        projectToMigrate.playwrightConfigFile,
        `${playwrightConfigFileContents.slice(
          0,
          projectToMigrate.commandValueNode.getStart()
        )}${newCommand}${playwrightConfigFileContents.slice(
          projectToMigrate.commandValueNode.getEnd()
        )}`
      );
      playwrightConfigFileContents = tree.read(
        projectToMigrate.playwrightConfigFile,
        'utf-8'
      );
      let ast = tsquery.ast(playwrightConfigFileContents);

      const BASE_URL_SELECTOR =
        'VariableDeclaration:has(Identifier[name=baseURL])';
      const baseUrlNodes = tsquery(ast, BASE_URL_SELECTOR, {
        visitAllChildren: true,
      });
      if (!baseUrlNodes.length) {
        return;
      }

      const baseUrlNode = baseUrlNodes[0];
      const newBaseUrlVariableDeclaration =
        "baseURL = process.env['BASE_URL'] || 'http://localhost:4300';";
      tree.write(
        projectToMigrate.playwrightConfigFile,
        `${playwrightConfigFileContents.slice(
          0,
          baseUrlNode.getStart()
        )}${newBaseUrlVariableDeclaration}${playwrightConfigFileContents.slice(
          baseUrlNode.getEnd()
        )}`
      );

      playwrightConfigFileContents = tree.read(
        projectToMigrate.playwrightConfigFile,
        'utf-8'
      );
      ast = tsquery.ast(playwrightConfigFileContents);
      const WEB_SERVER_URL_SELECTOR =
        'PropertyAssignment:has(Identifier[name=webServer]) PropertyAssignment:has(Identifier[name=url]) > StringLiteral';
      const webServerUrlNodes = tsquery(ast, WEB_SERVER_URL_SELECTOR, {
        visitAllChildren: true,
      });
      if (!webServerUrlNodes.length) {
        return;
      }

      const webServerUrlNode = webServerUrlNodes[0];
      const newWebServerUrl = "'http://localhost:4300'";
      tree.write(
        projectToMigrate.playwrightConfigFile,
        `${playwrightConfigFileContents.slice(
          0,
          webServerUrlNode.getStart()
        )}${newWebServerUrl}${playwrightConfigFileContents.slice(
          webServerUrlNode.getEnd()
        )}`
      );
    }
  }

  await addE2eCiTargetDefaults(tree);
  await formatFiles(tree);
}

async function getServeStaticTargetNameForConfigFile<T>(
  tree: Tree,
  pluginName: string,
  configFile: string,
  defaultTargetName: string,
  targetNamePluginOption: keyof T,
  createNodesV2: CreateNodesV2<T>
) {
  const nxJson = readNxJson(tree);
  const matchingPluginRegistrations = nxJson.plugins?.filter((p) =>
    typeof p === 'string' ? p === pluginName : p.plugin === pluginName
  );

  if (!matchingPluginRegistrations) {
    return defaultTargetName;
  }

  let targetName = defaultTargetName;
  for (const plugin of matchingPluginRegistrations) {
    let projectConfigs: ConfigurationResult;
    try {
      const loadedPlugin = new LoadedNxPlugin(
        { createNodesV2, name: pluginName },
        plugin
      );
      projectConfigs = await retrieveProjectConfigurations(
        [loadedPlugin],
        tree.root,
        nxJson
      );
    } catch (e) {
      if (e instanceof ProjectConfigurationsError) {
        projectConfigs = e.partialProjectConfigurationsResult;
      } else {
        throw e;
      }
    }

    if (projectConfigs.matchingProjectFiles.includes(configFile)) {
      targetName =
        typeof plugin === 'string'
          ? defaultTargetName
          : (plugin.options?.[targetNamePluginOption] as string) ??
            defaultTargetName;
    }
  }
  return targetName;
}
