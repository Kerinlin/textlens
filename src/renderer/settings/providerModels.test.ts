import type { ProviderModel, ThinkingCapability } from '../../shared'
import { mergeProviderModelsOnPick } from './providerModels'

const CAP_NONE: ThinkingCapability = {
  source: 'heuristic',
  dialect: null,
  supportsOff: true
}

const CAP_NATIVE: ThinkingCapability = {
  source: 'explicit',
  dialect: 'reasoningEffort',
  supportsOff: false
}

const CAP_PROMPT: ThinkingCapability = {
  source: 'heuristic',
  dialect: 'enableThinking',
  supportsOff: true
}

function model(
  id: string,
  name: string,
  extras?: Partial<ProviderModel>
): ProviderModel {
  return {
    id,
    name,
    thinkingLevels: extras?.thinkingLevels ?? [],
    ...(extras?.thinkingCapability !== undefined
      ? { thinkingCapability: extras.thinkingCapability }
      : {})
  }
}

describe('mergeProviderModelsOnPick', () => {
  it('keeps still-checked previous models in previous order and appends new remote', () => {
    const previous = [model('a', 'A'), model('b', 'B'), model('c', 'C')]
    const remote = [model('x', 'X'), model('b', 'B-remote'), model('y', 'Y'), model('a', 'A-remote')]

    const result = mergeProviderModelsOnPick({
      previous,
      remote,
      checkedIds: ['a', 'b', 'x', 'y']
    })

    expect(result.map((m) => m.id)).toEqual(['a', 'b', 'x', 'y'])
  })

  it('refreshes name and thinking fields from remote for matched ids', () => {
    const previous = [
      model('gpt', 'Old Name', {
        thinkingLevels: ['low'],
        thinkingCapability: CAP_NONE
      })
    ]
    const remote = [
      model('gpt', 'GPT-4o', {
        thinkingLevels: ['low', 'medium', 'high'],
        thinkingCapability: CAP_NATIVE
      })
    ]

    const result = mergeProviderModelsOnPick({
      previous,
      remote,
      checkedIds: new Set(['gpt'])
    })

    expect(result).toEqual([
      model('gpt', 'GPT-4o', {
        thinkingLevels: ['low', 'medium', 'high'],
        thinkingCapability: CAP_NATIVE
      })
    ])
  })

  it('keeps user-configured thinking levels unless the provider published explicit levels', () => {
    const previous = [
      model('gpt', 'Old Name', {
        thinkingLevels: ['high'],
        thinkingCapability: CAP_NONE
      })
    ]
    const silentRemote = [
      model('gpt', 'GPT-4o', {
        thinkingLevels: ['low', 'medium'],
        thinkingCapability: CAP_NONE
      })
    ]
    const explicitRemote = [
      model('gpt', 'GPT-4o', {
        thinkingLevels: ['low'],
        thinkingCapability: CAP_NATIVE
      })
    ]

    expect(mergeProviderModelsOnPick({
      previous,
      remote: silentRemote,
      checkedIds: ['gpt']
    })[0]?.thinkingLevels).toEqual(['high'])
    expect(mergeProviderModelsOnPick({
      previous,
      remote: explicitRemote,
      checkedIds: ['gpt']
    })[0]?.thinkingLevels).toEqual(['low'])
  })

  it('keeps manual-only previous metadata when still checked and absent from remote', () => {
    const previous = [
      model('manual-1', 'Manual Model', {
        thinkingLevels: ['high'],
        thinkingCapability: CAP_PROMPT
      }),
      model('remote-1', 'Remote Old')
    ]
    const remote = [model('remote-1', 'Remote New')]

    const result = mergeProviderModelsOnPick({
      previous,
      remote,
      checkedIds: ['manual-1', 'remote-1']
    })

    expect(result).toEqual([
      model('manual-1', 'Manual Model', {
        thinkingLevels: ['high'],
        thinkingCapability: CAP_PROMPT
      }),
      model('remote-1', 'Remote New')
    ])
  })

  it('drops unchecked previous models', () => {
    const previous = [model('keep', 'Keep'), model('drop', 'Drop')]
    const remote = [model('keep', 'Keep Remote'), model('drop', 'Drop Remote')]

    const result = mergeProviderModelsOnPick({
      previous,
      remote,
      checkedIds: ['keep']
    })

    expect(result).toEqual([model('keep', 'Keep Remote')])
  })

  it('returns empty list when nothing is checked', () => {
    const previous = [model('a', 'A')]
    const remote = [model('a', 'A'), model('b', 'B')]

    expect(
      mergeProviderModelsOnPick({
        previous,
        remote,
        checkedIds: []
      })
    ).toEqual([])

    expect(
      mergeProviderModelsOnPick({
        previous,
        remote,
        checkedIds: new Set()
      })
    ).toEqual([])
  })

  it('does not introduce duplicate ids', () => {
    const previous = [model('a', 'A-prev'), model('b', 'B-prev')]
    const remote = [model('b', 'B-remote'), model('a', 'A-remote'), model('c', 'C')]

    const result = mergeProviderModelsOnPick({
      previous,
      remote,
      checkedIds: ['a', 'b', 'c', 'a']
    })

    const ids = result.map((m) => m.id)
    expect(ids).toEqual(['a', 'b', 'c'])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('appends newly checked remote models in remote list order', () => {
    const previous = [model('kept', 'Kept')]
    const remote = [
      model('z', 'Z'),
      model('kept', 'Kept Remote'),
      model('m', 'M'),
      model('n', 'N')
    ]

    const result = mergeProviderModelsOnPick({
      previous,
      remote,
      checkedIds: new Set(['kept', 'n', 'm'])
    })

    expect(result.map((m) => m.id)).toEqual(['kept', 'm', 'n'])
    expect(result[0]?.name).toBe('Kept Remote')
  })
})
