import { PLANNING_FAILURE_CODES } from '@agentic/domain'
import { describe, expect, it } from 'vitest'
import { CreateDraftCommandSchema } from './commands.js'
import {
  PlanMissionCommandSchema,
  type PlannerDto,
  PlannerDtoSchema,
  PlanningFailureCodeSchema,
  PlanningFailureDtoSchema,
} from './planning.js'

const planner: PlannerDto = {
  providerId: 'agente-a',
  simulated: false,
  acceptsRevision: true,
  reportsUsage: false,
  state: 'INSTALLED',
}

describe('PlannerDto — quem planeja se apresenta pelo que e', () => {
  it('planejador real e planejador simulado sao distinguiveis no payload', () => {
    const deTeste: PlannerDto = { ...planner, simulated: true, state: 'READY' }

    expect(PlannerDtoSchema.safeParse(planner).success).toBe(true)
    expect(PlannerDtoSchema.safeParse(deTeste).success).toBe(true)
    expect(deTeste.simulated).not.toBe(planner.simulated)
  })

  it('nao existe planejador sem dizer se e simulado', () => {
    const { simulated: _omitido, ...semDeclarar } = planner

    expect(PlannerDtoSchema.safeParse(semDeclarar).success).toBe(false)
  })

  it('o ambiente do planejador usa a mesma derivacao do painel', () => {
    expect(PlannerDtoSchema.safeParse({ ...planner, state: 'UNKNOWN' }).success).toBe(true)
    expect(PlannerDtoSchema.safeParse({ ...planner, state: 'TALVEZ' }).success).toBe(false)
  })
})

describe('PlanMissionCommand — o consumo de assinatura e aceito antes, nunca depois', () => {
  const comando = {
    prompt: 'quero um relatorio de estoque por deposito',
    acceptsSubscriptionUse: true,
    actor: 'ewaldo',
  }

  it('texto livre, aceite explicito e autor bastam', () => {
    expect(PlanMissionCommandSchema.safeParse(comando).success).toBe(true)
  })

  it('sem aceite declarado o comando nao passa: o aviso nao pode ser esquecido', () => {
    const { acceptsSubscriptionUse: _omitido, ...semAceite } = comando

    expect(PlanMissionCommandSchema.safeParse(semAceite).success).toBe(false)
  })

  it('sem autor o comando nao passa: o servidor nao inventa quem pediu', () => {
    const { actor: _omitido, ...semAutor } = comando

    expect(PlanMissionCommandSchema.safeParse(semAutor).success).toBe(false)
  })

  it('prompt vazio e recusado', () => {
    expect(PlanMissionCommandSchema.safeParse({ ...comando, prompt: '   ' }).success).toBe(false)
  })

  it('escolher o planejador e opcional: com um so, escolher e desnecessario', () => {
    const escolhido = PlanMissionCommandSchema.safeParse({ ...comando, plannerId: 'agente-b' })

    expect(escolhido.success).toBe(true)
    expect(PlanMissionCommandSchema.safeParse(comando).success).toBe(true)
  })

  it('o comando nao carrega o arquivo da missao: quem grava e o control plane', () => {
    const tentandoEscrever = { ...comando, file: '.agentic/missions/inventada.yaml' }

    expect(PlanMissionCommandSchema.safeParse(tentandoEscrever).success).toBe(false)
  })
})

describe('falha de planejamento e diagnostico, nao plano vazio', () => {
  it('carrega codigo, frase legivel, onde errou e quantas correcoes foram gastas', () => {
    const parsed = PlanningFailureDtoSchema.safeParse({
      code: 'CONTRACT_REJECTED',
      message: 'a proposta nao respeita o contrato de missao',
      problems: [{ path: 'tasks[0].objective', message: 'nao pode ser vazio' }],
      revisions: 2,
      plannerId: 'agente-a',
    })

    expect(parsed.success).toBe(true)
  })

  it('o catalogo de codigos vem do dominio, nao de uma copia', () => {
    for (const code of PLANNING_FAILURE_CODES) {
      expect(PlanningFailureCodeSchema.safeParse(code).success).toBe(true)
    }
    expect(PlanningFailureCodeSchema.safeParse('DEU_RUIM').success).toBe(false)
  })
})

describe('CreateDraftCommand — ver o DAG antes de aprovar', () => {
  it('exige exatamente um entre caminho e id', () => {
    expect(CreateDraftCommandSchema.safeParse({ missionId: 'DA-EXEMPLO-002' }).success).toBe(true)
    expect(CreateDraftCommandSchema.safeParse({ missionPath: 'missoes/m.yaml' }).success).toBe(true)
    expect(CreateDraftCommandSchema.safeParse({}).success).toBe(false)
    expect(
      CreateDraftCommandSchema.safeParse({ missionId: 'DA-EXEMPLO-002', missionPath: 'm.yaml' })
        .success,
    ).toBe(false)
  })

  it('criar rascunho nao aceita `actor`: rascunho nao e aprovacao', () => {
    const comAtor = { missionId: 'DA-EXEMPLO-002', actor: 'ewaldo' }

    expect(CreateDraftCommandSchema.safeParse(comAtor).success).toBe(false)
  })
})
