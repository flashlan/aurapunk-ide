import { describe, expect, it } from 'vitest';
import type { SidebarTreeNode } from './types';
import { findAncestorIds, findNodeIdByPredicate } from './openState';

const tree = (): SidebarTreeNode[] =>
  [
    {
      id: 'p1',
      type: 'project',
      name: 'p1',
      color: '0 0% 50%',
      parentId: null,
      sortOrder: 0,
      children: [
        {
          id: 'p1:tasks',
          type: 'section',
          kind: 'tasks',
          projectId: 'p1',
          name: 'Tasks',
          children: [
            {
              id: 'p1:status:s1',
              type: 'status',
              projectId: 'p1',
              statusId: 's1',
              name: 'Todo',
              color: '0 0% 50%',
              children: [
                {
                  id: 'p1:card:i1',
                  type: 'card',
                  issue: {
                    id: 'i1',
                    title: 'card one',
                    priority: null,
                    statusId: 's1',
                    projectId: 'p1',
                    parentIssueId: null,
                  },
                  children: [
                    {
                      id: 'p1:card:i2',
                      type: 'card',
                      issue: {
                        id: 'i2',
                        title: 'sub card',
                        priority: null,
                        statusId: 's1',
                        projectId: 'p1',
                        parentIssueId: 'i1',
                      },
                      children: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          id: 'p1:workspaces',
          type: 'section',
          kind: 'workspaces',
          projectId: 'p1',
          name: 'Workspaces',
          children: [
            {
              id: 'p1:workspaces:leaf:w1',
              type: 'leaf',
              workspace: { id: 'w1', name: 'w1' } as never,
            },
          ],
        },
      ],
    },
  ] as unknown as SidebarTreeNode[];

describe('findNodeIdByPredicate', () => {
  it('finds a card by issue id regardless of nesting depth', () => {
    const id = findNodeIdByPredicate(
      tree(),
      (node) => node.type === 'card' && node.issue.id === 'i2'
    );
    expect(id).toBe('p1:card:i2');
  });

  it('finds a workspace leaf by workspace id', () => {
    const id = findNodeIdByPredicate(
      tree(),
      (node) => node.type === 'leaf' && node.workspace.id === 'w1'
    );
    expect(id).toBe('p1:workspaces:leaf:w1');
  });

  it('returns null when nothing matches', () => {
    expect(findNodeIdByPredicate(tree(), () => false)).toBeNull();
  });
});

describe('findAncestorIds', () => {
  it('returns the path of a deeply nested card, outermost first', () => {
    expect(findAncestorIds(tree(), 'p1:card:i2')).toEqual([
      'p1',
      'p1:tasks',
      'p1:status:s1',
      'p1:card:i1',
    ]);
  });

  it('returns the path of a workspace leaf', () => {
    expect(findAncestorIds(tree(), 'p1:workspaces:leaf:w1')).toEqual([
      'p1',
      'p1:workspaces',
    ]);
  });

  it('returns an empty list for an unknown id', () => {
    expect(findAncestorIds(tree(), 'nope')).toEqual([]);
  });
});
