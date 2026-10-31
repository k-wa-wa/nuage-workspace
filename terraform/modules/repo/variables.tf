variable "repository_config" {
  type = object({
    name        = string
    description = string
  })
}

variable "bypass_mode" {
  type        = string
  default     = "always"
  description = "ルールセットで Admin を素通しにする方式。\"pull_request\" なら PR のマージのときだけ素通しで、直接 push はできない。"

  validation {
    condition     = contains(["always", "pull_request", "exempt"], var.bypass_mode)
    error_message = "bypass_mode は always / pull_request / exempt のいずれかにする。"
  }
}

variable "required_status_checks" {
  type        = list(string)
  default     = []
  description = "マージの必須にするチェックの名前。空なら必須チェックを置かない。GitHub Actions (15368) が出したものに限る。"
}
